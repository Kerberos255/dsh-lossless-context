import { PluginConfig } from './plugin-settings/remote-config.js';
import { schema } from './config.js';
import { LosslessIndex } from './index-store.js';
import { inspectRotation } from './rotation-guard.js';
export const inject=['dshHomePath'];
export function apply(ctx,legacy={}){
 let index=null,error='',settings;
 const engines=new Set(),liveSeq=new Map();
 settings=new PluginConfig(ctx,{service:'losslessContext',packageName:'dsh-lossless-context',schema,details:()=>{
  let rotation;try{rotation=inspectRotation(ctx.dshHomePath(),index,settings.configFile.value,liveSeq);}
  catch{rotation={rotationStatus:'会话元数据暂不可读；本次不执行轮转判断。',rotationHandoff:'无需操作；LCM 不会自动重置会话。'};}
  return {message:error||`已索引 ${index?.stats().indexedEvents??0} 个事件 · ${index?.stats().nodes??0} 个摘要节点 · ${engines.size} 个运行时`,...(index?.stats()??{}),activeEngines:engines.size,...rotation};
 }},legacy);
 settings.index=null;settings.engines=engines;settings.tasks=new Set();
 settings.health=({sessionId}={})=>{
  const enabled=settings.configFile.value.enabled;if(settings.configFile.closed)throw new Error('LCM 已卸载');
  const where=sessionId?' WHERE session_id=?':'',args=sessionId?[sessionId]:[];
  const total=table=>index?.db.prepare('SELECT COUNT(*) AS count FROM '+table+where).get(...args).count??null;
  return {enabled,available:!!index&&!error,indexedEvents:total('lcm_refs'),nodes:total('lcm_nodes'),auxiliaryCalls:total('lcm_aux_calls'),activeCompactions:index?.db.prepare("SELECT COUNT(*) AS count FROM lcm_compactions WHERE state='running'"+(sessionId?' AND session_id=?':'')).get(...args).count??null,thresholdRatio:settings.configFile.value.thresholdRatio};
 };
 try{index=new LosslessIndex(ctx.dshHomePath('lossless-context','index.sqlite'),settings.configFile.value);settings.index=index;}
 catch{error='索引暂不可用，继续使用原生压缩；请检查插件数据目录。';}
 settings.configFile.subscribe(snapshot=>{if(index)index.maxIndexedChars=snapshot.value.maxIndexedChars;});
 ctx.on('session/event',(session,event)=>{
  // Track counts independently of index availability; never force Session changes.
  liveSeq.set(session.id,Math.max(liveSeq.get(session.id)??0,event.seq+1));
  if(liveSeq.size>2000)liveSeq.delete(liveSeq.keys().next().value);
  if(!index||!settings.configFile.value.enabled)return;
  try{index.observe(session,event);}catch{error='索引有未同步事件，下次检索将补齐。';}
 },{global:true});
 ctx.effect(()=>async()=>{for(const engine of engines)engine.abortSummary();await Promise.allSettled(settings.tasks);index?.close();settings.index=null;});
}
