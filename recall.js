import { readFileSync } from 'node:fs';
import { eventText } from './index-store.js';
const integer=(value,fallback,max)=>Number.isSafeInteger(value)&&value>=0?Math.min(value,max):fallback;
export function nativeSources(session,seqs){
 const originals=new Set(),visited=new Set(),pending=[...seqs];
 while(pending.length){const seq=pending.pop();if(visited.has(seq))continue;visited.add(seq);const event=session.eventAt(seq);if(!event)throw new Error('lcm-native-event-missing');
  if(event.sourceEventSeqs?.length)pending.push(...event.sourceEventSeqs);else originals.add(seq);
  if(visited.size>1000000)throw new Error('lcm-expansion-too-large');
 }return [...originals].sort((a,b)=>a-b);
}
export function recall(index,session,kind,args,{maxRecallChars=16000}={}){
 index.sync(session);const limit=integer(args.limit,10,50),offset=integer(args.offset,0,100000000);
 if(kind==='grep'&&args.scope==='files'){
  if(typeof args.query!=='string'||!args.query.trim()||args.query.length>1000)throw new Error('lcm-query-invalid');
  if(typeof index.searchFiles!=='function')throw new Error('lcm-files-unavailable');
  return {files:index.searchFiles(session.id,args.query,limit)};
 }
 if(kind==='describe'){
  if(!args.id){const nodes=index.list(session.id,limit),files=typeof index.files==='function'?index.files(session.id,limit):[];return files.length?{nodes,files}:{nodes};}
  if(String(args.id).startsWith('file_')){
   if(typeof index.file!=='function')throw new Error('lcm-files-unavailable');
   const file=index.file(session.id,args.id);
   if(!file)throw new Error('lcm-file-not-found');
   return {file:{id:file.id,chars:file.chars,createdAt:file.createdAt,excerpt:file.excerpt}};
  }
  const node=index.node(session.id,args.id);if(!node)throw new Error('lcm-node-not-found');
  return {id:node.id,kind:node.kind,depth:node.depth,children:node.children,sourceSeqs:node.sourceSeqs,summary:node.summary??eventText(session.eventAt(node.summary_seq))};
 }
 let seqs;
 if(String(args.id??'').startsWith('file_')){
  if(typeof index.file!=='function')throw new Error('lcm-files-unavailable');
  const file=index.file(session.id,args.id);
  if(!file)throw new Error('lcm-file-not-found');
  const body=readFileSync(file.path,'utf8');
  const text=body.slice(offset,offset+maxRecallChars);
  return {file:{id:file.id,chars:file.chars},items:[{id:file.id,text}],offset,nextOffset:offset+text.length<body.length?offset+text.length:null,truncated:offset+text.length<body.length};
 }
 if(kind==='grep'){
  if(typeof args.query!=='string'||!args.query.trim()||args.query.length>1000)throw new Error('lcm-query-invalid');
  const matches=index.search(session.id,args.query,limit);
  return {matches:matches.map(match=>({...match,excerpt:eventText(session.eventAt(match.seq)).slice(0,240)}))}
 }else if(typeof args.query==='string'&&args.query.trim()){if(args.query.length>1000)throw new Error('lcm-query-invalid');seqs=index.search(session.id,args.query,limit).map(match=>match.seq);}else if(args.id)seqs=index.sources(session.id,args.id);
 else if(Number.isSafeInteger(args.seq)&&args.seq>=0)seqs=[args.seq];
 else throw new Error('lcm-source-required');
 seqs=nativeSources(session,seqs);
 const items=[];let used=0,remainingOffset=offset;
 for(const seq of seqs){const event=session.eventAt(seq);if(!event)throw new Error('lcm-native-event-missing');const body=eventText(event);if(remainingOffset>=body.length){remainingOffset-=body.length;continue;}const text=body.slice(remainingOffset,remainingOffset+maxRecallChars-used);remainingOffset=0;items.push({seq,type:event.type,text});used+=text.length;if(used>=maxRecallChars)break;}
 return {items,offset,nextOffset:used===maxRecallChars?offset+used:null,truncated:used===maxRecallChars};
}
export function installRecall(ctx,getIndex,getConfig){
 return ctx.inject(['tools'],scope=>{
  scope.tools.register({
   name:'lcm_recall',
   description:'只读召回当前 Session 原文。action=search（默认）检索片段（scope=files 检索已外置的大文件），action=describe 查看摘要 DAG 或文件说明，action=expand 按 seq、id 或 query 分段展开完整原文（id=file_… 读取外置文件）。仅访问调用者当前 Session。',
   parameters:{type:'object',properties:{
    action:{type:'string',enum:['search','describe','expand']},
    query:{type:'string'},id:{type:'string'},scope:{type:'string',enum:['events','files']},seq:{type:'integer',minimum:0},
    limit:{type:'integer',minimum:1,maximum:50},offset:{type:'integer',minimum:0}
   },additionalProperties:false},
   output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
   async execute(args,exec){
    exec.signal.throwIfAborted();
    const index=getIndex(),config=getConfig();
    if(!index||!config?.enabled||!config.recall||!exec.agent?.session)throw new Error('lcm-recall-unavailable');
    const action=args.action??'search';
    if(action==='search'&&(typeof args.query!=='string'||!args.query.trim()||args.id!==undefined||args.seq!==undefined||args.offset!==undefined))throw new Error('lcm-search-arguments-invalid');
      if(action!=='search'&&args.scope!==undefined)throw new Error('lcm-scope-not-supported');
    if(action==='describe'&&(args.query!==undefined||args.seq!==undefined||args.offset!==undefined))throw new Error('lcm-describe-arguments-invalid');
    if(action==='expand'&&[args.query!==undefined&&!!args.query.trim(),args.id!==undefined,args.seq!==undefined].filter(Boolean).length!==1)throw new Error('lcm-expand-source-invalid');
    const value=recall(index,exec.agent.session,action==='search'?'grep':action,args,config);
    exec.signal.throwIfAborted();
    return value;
   }
  });
 });
}
