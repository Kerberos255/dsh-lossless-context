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
 if(kind==='describe'){
  if(!args.id)return {nodes:index.list(session.id,limit)};
  const node=index.node(session.id,args.id);if(!node)throw new Error('lcm-node-not-found');
  return {id:node.id,kind:node.kind,depth:node.depth,children:node.children,sourceSeqs:node.sourceSeqs,summary:node.summary??eventText(session.eventAt(node.summary_seq))};
 }
 let seqs;
 if(kind==='grep'||kind==='expand-query'){
  if(typeof args.query!=='string'||!args.query.trim()||args.query.length>1000)throw new Error('lcm-query-invalid');
  const matches=index.search(session.id,args.query,limit);
  if(kind==='grep')return {matches:matches.map(match=>({...match,excerpt:eventText(session.eventAt(match.seq)).slice(0,240)}))};seqs=matches.map(match=>match.seq);
 }else if(args.id)seqs=index.sources(session.id,args.id);
 else if(Number.isSafeInteger(args.seq)&&args.seq>=0)seqs=[args.seq];
 else throw new Error('lcm-source-required');
 seqs=nativeSources(session,seqs);
 const items=[];let used=0,remainingOffset=offset;
 for(const seq of seqs){const event=session.eventAt(seq);if(!event)throw new Error('lcm-native-event-missing');const body=eventText(event);if(remainingOffset>=body.length){remainingOffset-=body.length;continue;}const text=body.slice(remainingOffset,remainingOffset+maxRecallChars-used);remainingOffset=0;items.push({seq,type:event.type,text});used+=text.length;if(used>=maxRecallChars)break;}
 return {items,offset,nextOffset:used===maxRecallChars?offset+used:null,truncated:used===maxRecallChars};
}
export function installRecall(ctx,getIndex,getConfig){
 return ctx.inject(['tools'],scope=>{
  for(const [name,kind,description]of [['lcm_grep','grep','在当前会话原文中检索词语，支持中文；返回事件序号和简短片段。'],['lcm_describe','describe','查看当前会话摘要 DAG 节点及来源。'],['lcm_expand','expand','按事件序号或摘要节点展开当前会话原文；按 offset 分页读取。'],['lcm_expand_query','expand-query','按检索词展开当前会话匹配原文，返回长度受配置限制。']])scope.tools.register({name,description,
   parameters:{type:'object',properties:{query:{type:'string'},id:{type:'string'},seq:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:50},offset:{type:'integer',minimum:0}},additionalProperties:false},
   output:{schema:{type:'object',additionalProperties:true},render:(_args,value)=>[{type:'text',text:JSON.stringify(value)}]},
   async execute(args,exec){exec.signal.throwIfAborted();const index=getIndex(),config=getConfig();if(!index||!config?.enabled||!config.recall||!exec.agent)throw new Error('lcm-recall-unavailable');return recall(index,exec.agent.session,kind,args,config);},
  });
 });
}
