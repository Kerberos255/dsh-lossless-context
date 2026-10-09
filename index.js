import { PluginConfig } from './plugin-settings/remote-config.js';
import { schema } from './config.js';
import { LosslessIndex } from './index-store.js';
import { inspectRotation } from './rotation-guard.js';
import { installAutoRotation } from './auto-rotation.js';
export const inject=['dshHomePath'];
export function apply(ctx,legacy={}){
 let index=null,error='',settings,autoRotation;
 const engines=new Set(),liveSeq=new Map();
 settings=new PluginConfig(ctx,{service:'losslessContext',packageName:'dsh-lossless-context',schema,details:()=>{
  const memory=ctx.get('memoryDreaming'),core=ctx.get('channelCore');
  const ready=!!(memory?.configFile.value.enabled&&memory.configFile.value.ownerIdentityId&&memory.configFile.value.autoPromote&&core?.configFile.value.sharedDM);
  const reason=!core?'渠道绑定服务未就绪':!core.configFile.value.sharedDM?'未开启共享私聊':!memory?.configFile.value.enabled?'Dream 插件未启用':!memory.configFile.value.ownerIdentityId?'Dream 未配置记忆主人身份':!memory.configFile.value.autoPromote?'Dream 未允许核验后发布候选':'服务尚未就绪';
  const status=autoRotation?.summary();
  const warm=[...engines].map(engine=>engine.warmStats).filter(Boolean);
  const lastWarm=warm.toSorted((a,b)=>b.lastAt-a.lastAt)[0];
  const requests=warm.reduce((sum,row)=>sum+(row.leafRequests??0),0),leafHits=warm.reduce((sum,row)=>sum+(row.leafHits??0),0);
  const warmStatus=warm.length?`${lastWarm?.lastState??'未开始'} · 预备尝试 ${warm.reduce((sum,row)=>sum+row.attempts,0)} 次 · 已预备 ${warm.reduce((sum,row)=>sum+row.prepared,0)} 个 · 实际叶缓存命中率 ${requests?(100*leafHits/requests).toFixed(1)+'%':'暂无调用'} · 失败 ${warm.reduce((sum,row)=>sum+row.failures,0)} 次`:'LCM 压缩后端尚未加载';
  const warmBudgetStatus=lastWarm?.lastThreshold?`提前预备 ${lastWarm.lastTrigger.toLocaleString()} token · 正式压缩 ${lastWarm.lastThreshold.toLocaleString()} token · 实际安全余量 ${lastWarm.lastHeadroom.toLocaleString()} token`: '待当前模型首次测量';
  const warmFailure=lastWarm?.lastError||'无';
  let rotation;try{rotation=inspectRotation(ctx.dshHomePath(),index,settings.configFile.value,liveSeq,{ready,reason});
   if(status?.busy)rotation.rotationStatus+=' · 正在整理 '+status.busy+' 个会话';
   if(status?.latestError)rotation.rotationStatus+=' · 最近一次自动轮转中止：'+status.latestError;}
  catch{rotation={rotationStatus:'原生会话元数据暂不可读，自动轮转未运行。'};}
  return {message:error||`已索引 ${index?.stats().indexedEvents??0} 个事件 · ${index?.stats().nodes??0} 个摘要节点 · ${engines.size} 个运行时`,...(index?.stats()??{}),activeEngines:engines.size,warmStatus,warmBudgetStatus,warmFailure,...rotation};
 }},legacy);
 settings.index=null;settings.engines=engines;settings.tasks=new Set();
 autoRotation=installAutoRotation(ctx,settings.configFile);
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
