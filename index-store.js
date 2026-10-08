import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const hash=value=>createHash('sha256').update(value).digest('hex');
const textBlocks=blocks=>(blocks??[]).filter(block=>block.type==='text'||block.type==='refusal').map(block=>block.text??block.refusal??'').join('\n');
export function eventText(event){
 if(event.type==='compaction/summary')return textBlocks(event.data.summary);
 if(['user/message','developer/message'].includes(event.type))return textBlocks(event.data.content);
 if(['assistant/message','tool/result'].includes(event.type))return textBlocks(event.data.message?.content);
 return '';
}
export function terms(text){
 const words=new Set((text.toLowerCase().replace(/[\p{Script=Han}]+/gu,' ').match(/[\p{L}\p{N}_-]+/gu)??[]).map(word=>word.slice(0,128)));
 for(const run of text.match(/[\p{Script=Han}]+/gu)??[])for(let i=0;i<run.length;i++){words.add(run[i]);if(i+1<run.length)words.add(run.slice(i,i+2));if(i+2<run.length)words.add(run.slice(i,i+3));}
 return [...words].slice(0,16000);
}
function queryTerms(query){
 const words=(query.toLowerCase().match(/[\p{Script=Han}]+|[\p{L}\p{N}_-]+/gu)??[]).flatMap(word=>/[\p{Script=Han}]/u.test(word)?(word.length<3?[word]:Array.from({length:word.length-1},(_,i)=>word.slice(i,i+2))):[word]);
 return [...new Set(words)].slice(0,24).map(word=>'"'+word.replaceAll('"','""')+'"').join(' AND ');
}
/** Derived summaries, postings and immutable native references. No mirrored transcript. */
export class LosslessIndex {
 constructor(filename,{maxIndexedChars=32768}={}){
  this.maxIndexedChars=maxIndexedChars;this.closed=false;if(filename!==':memory:')mkdirSync(path.dirname(filename),{recursive:true});this.db=new DatabaseSync(filename);
  this.db.exec(`PRAGMA journal_mode=WAL;PRAGMA synchronous=NORMAL;PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS lcm_cursor(session_id TEXT PRIMARY KEY,next_seq INTEGER NOT NULL);
   CREATE TABLE IF NOT EXISTS lcm_refs(id INTEGER PRIMARY KEY,session_id TEXT NOT NULL,seq INTEGER NOT NULL,type TEXT NOT NULL,chars INTEGER NOT NULL,digest TEXT NOT NULL,index_truncated INTEGER NOT NULL,UNIQUE(session_id,seq));
   CREATE INDEX IF NOT EXISTS lcm_refs_session ON lcm_refs(session_id,seq);
   CREATE VIRTUAL TABLE IF NOT EXISTS lcm_terms USING fts5(terms,content='',contentless_delete=1);
   CREATE TABLE IF NOT EXISTS lcm_compactions(session_id TEXT NOT NULL,id TEXT NOT NULL,start_seq INTEGER NOT NULL,summary_seq INTEGER,shadowed TEXT,plan TEXT,state TEXT NOT NULL,PRIMARY KEY(session_id,id));
   CREATE TABLE IF NOT EXISTS lcm_nodes(session_id TEXT NOT NULL,id TEXT NOT NULL,compaction_id TEXT NOT NULL,kind TEXT NOT NULL,depth INTEGER NOT NULL,summary_seq INTEGER,summary TEXT,source_seqs TEXT NOT NULL,children TEXT NOT NULL,PRIMARY KEY(session_id,id));
   CREATE TABLE IF NOT EXISTS lcm_aux_calls(session_id TEXT,id TEXT,ordinal INTEGER,kind TEXT,metadata TEXT,PRIMARY KEY(session_id,id,ordinal));
  `);
 }
 tx(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(error){this.db.exec('ROLLBACK');throw error;}}
 cursor(sessionId){return this.db.prepare('SELECT next_seq FROM lcm_cursor WHERE session_id=?').get(sessionId)?.next_seq??0;}
 sync(session){
  if(this.closed)throw new Error('lcm-index-closed');let cursor=this.cursor(session.id);
  if(cursor>session.seq){this.reset(session.id);cursor=0;}
  if(cursor===session.seq)return;
  this.tx(()=>{for(let seq=cursor;seq<session.seq;seq++){const event=session.eventAt(seq);if(event)this.fold(session,event);}this.db.prepare('INSERT INTO lcm_cursor VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET next_seq=excluded.next_seq').run(session.id,session.seq);});
 }
 observe(session,event){
  if(this.closed)return;
  const cursor=this.cursor(session.id);if(cursor>session.seq){this.reset(session.id);this.sync(session);return;}if(cursor>event.seq)return;
  if(cursor!==event.seq){this.sync(session);return;}
  this.tx(()=>{this.fold(session,event);this.db.prepare('INSERT INTO lcm_cursor VALUES(?,?) ON CONFLICT(session_id) DO UPDATE SET next_seq=excluded.next_seq').run(session.id,event.seq+1);});
 }
 fold(session,event){
  const body=eventText(event),id=session.id;
  if(body){
   const existing=this.db.prepare('SELECT id FROM lcm_refs WHERE session_id=? AND seq=?').get(id,event.seq);
   if(!existing){const limited=body.length<=this.maxIndexedChars?body:body.slice(0,this.maxIndexedChars/2)+'\n'+body.slice(-this.maxIndexedChars/2),result=this.db.prepare('INSERT INTO lcm_refs(session_id,seq,type,chars,digest,index_truncated) VALUES(?,?,?,?,?,?)').run(id,event.seq,event.type,body.length,hash(body),Number(limited!==body));this.db.prepare('INSERT INTO lcm_terms(rowid,terms) VALUES(?,?)').run(result.lastInsertRowid,terms(limited).join(' '));}
  }
  const data=event.data;
  if(event.type==='compaction/start')this.db.prepare("INSERT OR IGNORE INTO lcm_compactions VALUES(?,?,?,NULL,NULL,NULL,'running')").run(id,data.compactionId,event.seq);
  if(event.type==='compaction/summary')this.db.prepare('UPDATE lcm_compactions SET summary_seq=?,shadowed=? WHERE session_id=? AND id=?').run(event.seq,JSON.stringify(data.shadowedSeqs),id,data.compactionId);
  if(event.type==='compaction/end'){
   const row=this.db.prepare('SELECT * FROM lcm_compactions WHERE session_id=? AND id=?').get(id,data.compactionId);
   if(!row)return;
   if(data.error||row.summary_seq===null){this.db.prepare("UPDATE lcm_compactions SET state='failed' WHERE session_id=? AND id=?").run(id,data.compactionId);return;}
   this.commitNodes(session,row);this.db.prepare("UPDATE lcm_compactions SET state='committed' WHERE session_id=? AND id=?").run(id,data.compactionId);
  }
 }
 active(sessionId){return this.db.prepare("SELECT id FROM lcm_compactions WHERE session_id=? AND state='running' ORDER BY start_seq DESC LIMIT 1").get(sessionId)?.id;}
 plan(sessionId,id,plan){if(this.closed)throw new Error('lcm-index-closed');this.db.prepare('UPDATE lcm_compactions SET plan=? WHERE session_id=? AND id=?').run(JSON.stringify(plan),sessionId,id);}
 auxiliary(sessionId,id,ordinal,kind,metadata){if(this.closed)throw new Error('lcm-index-closed');this.db.prepare('INSERT OR REPLACE INTO lcm_aux_calls VALUES(?,?,?,?,?)').run(sessionId,id,ordinal,kind,JSON.stringify(metadata));}
 commitNodes(session,row){
  const seqs=JSON.parse(row.shadowed),messageSeqs=seqs.filter(seq=>session.deriveEventMessage(session.eventAt(seq))!=null),plan=row.plan?JSON.parse(row.plan):{leaves:[]},leaves=Array.isArray(plan)?plan:plan.leaves,id=row.id;
  const checkpoints=range=>range.map(seq=>session.eventAt(seq)).filter(event=>event?.type==='user/message'&&event.data.source?.kind==='compact-checkpoint').map(event=>event.data.source.compactionId).filter(child=>this.node(session.id,child));
  const put=(node,kind,summarySeq,summary,sources,children)=>{const depth=children.length?Math.max(...children.map(child=>this.node(session.id,child)?.depth??0))+1:0;this.db.prepare('INSERT OR REPLACE INTO lcm_nodes VALUES(?,?,?,?,?,?,?,?,?)').run(session.id,node,id,kind,depth,summarySeq,summary,JSON.stringify(sources),JSON.stringify(children));return node;};
  if(leaves.length<=1){put(id,'leaf',row.summary_seq,null,seqs,checkpoints(seqs));return;}
  const leafIds=leaves.map((leaf,index)=>{const sources=messageSeqs.slice(leaf.start,leaf.end);return put(id+':leaf:'+index,'leaf',null,leaf.summary,sources,checkpoints(sources));});
  for(const branch of plan.branches??[]){const children=branch.children.map(child=>id+':'+child),sources=[...new Set(children.flatMap(child=>this.node(session.id,child).sourceSeqs))];put(id+':'+branch.id,'condensed',null,branch.summary,sources,children);}
  const children=plan.rootChildren?.map(child=>id+':'+child)??leafIds;
  put(id,'condensed',row.summary_seq,null,seqs,children);
 }
 node(sessionId,id){const row=this.db.prepare('SELECT * FROM lcm_nodes WHERE session_id=? AND id=?').get(sessionId,id);return row&&{...row,sourceSeqs:JSON.parse(row.source_seqs),children:JSON.parse(row.children)};}
 list(sessionId,limit=20){return this.db.prepare('SELECT id,kind,depth,summary_seq FROM lcm_nodes WHERE session_id=? ORDER BY rowid DESC LIMIT ?').all(sessionId,limit);}
 search(sessionId,query,limit=20){const match=queryTerms(query);if(!match)return [];return this.db.prepare('SELECT r.seq,r.type,r.chars,r.index_truncated AS indexTruncated FROM lcm_terms JOIN lcm_refs r ON r.id=lcm_terms.rowid WHERE lcm_terms MATCH ? AND r.session_id=? ORDER BY r.seq DESC LIMIT ?').all(match,sessionId,limit);}
 sources(sessionId,id,{maxEvents=1000000}={}){
  const result=new Set(),visited=new Set();const walk=nodeId=>{if(visited.has(nodeId))return;visited.add(nodeId);const node=this.node(sessionId,nodeId);if(!node)throw new Error('lcm-node-not-found');for(const child of node.children)walk(child);for(const seq of node.sourceSeqs)if(result.size<maxEvents)result.add(seq);};walk(id);return [...result].sort((a,b)=>a-b);
 }
 stats(){return {indexedEvents:this.db.prepare('SELECT count(*) AS n FROM lcm_refs').get().n,nodes:this.db.prepare('SELECT count(*) AS n FROM lcm_nodes').get().n,auxiliaryCalls:this.db.prepare('SELECT count(*) AS n FROM lcm_aux_calls').get().n,activeCompactions:this.db.prepare("SELECT count(*) AS n FROM lcm_compactions WHERE state='running'").get().n};}
 reset(sessionId){const ids=this.db.prepare('SELECT id FROM lcm_refs WHERE session_id=?').all(sessionId);for(const {id}of ids)this.db.prepare('DELETE FROM lcm_terms WHERE rowid=?').run(id);for(const table of ['lcm_refs','lcm_compactions','lcm_nodes','lcm_aux_calls','lcm_cursor'])this.db.prepare(`DELETE FROM ${table} WHERE session_id=?`).run(sessionId);}
 close(){if(this.closed)return;this.closed=true;this.db.close();}
}
