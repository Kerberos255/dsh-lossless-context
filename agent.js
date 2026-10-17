import { BasicCompactionEngine } from './native/basic-compaction-rc2.js';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { createHash, randomUUID } from 'node:crypto';
import { nativeConfig } from './config.js';
import { leafPlan,summaryBudget,summaryText } from './planner.js';
import { installRecall } from './recall.js';
import { summarizeComplete } from './summarizer.js';
import { warmBudget,scopedNativeConfig,deferredPressureBudget,retainedTailTokens } from './pressure.js';

/** Preset-scoped native backend; all surface commits and replay stay native. */
export default class LosslessCompaction extends BasicCompactionEngine {
 static inject=BasicCompactionEngine.inject;
 constructor(ctx,config={}){
  const settings=ctx.get('losslessContext');super(ctx,settings?nativeConfig(settings.configFile.value):config);
  this.settings=null;this.pendingConfig=null;this.summaryAborts=new Set();this.idleAbort=null;this.idleAgent=null;this.idleTimer=null;this.idleTask=null;this.pendingTurnEnds=new Map();this.postTurnBusyRetries=new Map();this.postTurnTimer=null;this.postTurnTask=null;this.postTurnAbort=null;this.postTurnAgent=null;this.postTurnStatus='尚未执行';this.warmed=new Map();this.warmStats={attempts:0,prepared:0,hits:0,leafRequests:0,leafHits:0,failures:0,cancelled:0,lastState:'未开始',lastError:'',lastAt:0,lastThreshold:0,lastTrigger:0,lastHeadroom:0};
  ctx.inject(['losslessContext'],scope=>{
   const owner=scope.losslessContext;this.settings=owner;owner.engines.add(this);
   const update=()=>{this.warmed.clear();this.idleAbort?.abort();this.postTurnAbort?.abort();const value=nativeConfig(owner.configFile.value);if(this.summaryAborts.size)this.pendingConfig=value;else this.config=value;};update();
   const unsubscribe=owner.configFile.subscribe(update),recall=installRecall(scope,()=>this.settings?.index,()=>this.settings?.configFile.value);
   scope.effect(()=>()=>{unsubscribe();recall?.dispose?.();owner.engines.delete(this);this.abortSummary();if(this.settings===owner)this.settings=null;});
  });
  ctx.on('session/event',(session,event)=>{if(event.type!=='turn/end'||!Number.isSafeInteger(event.seq)||!this.settings?.configFile.value.enabled||!this.settings.configFile.value.automatic||this.settings.configFile.value.compressionTiming!=='after-turn')return;this.postTurnBusyRetries.delete(session.id);this.pendingTurnEnds.set(session.id,event.seq);if(this.pendingTurnEnds.size>500)this.pendingTurnEnds.delete(this.pendingTurnEnds.keys().next().value);const agent=ctx.get('agents')?.get(session.id);if(agent?.status==='idle')this.queuePostTurn(agent);});
  ctx.on('agent/status',({agent,status})=>{if(status!=='idle')return;if(this.pendingTurnEnds.has(agent.session.id)&&this.settings?.configFile.value.compressionTiming==='after-turn'){this.queuePostTurn(agent);return;}if(this.idleTimer||this.idleTask||this.postTurnTimer||this.postTurnTask||!this.settings?.configFile.value.deferred)return;this.idleTimer=setTimeout(()=>{this.idleTimer=null;const owner=this.settings,task=this.idleMaintenance(agent).catch(error=>{if(error?.name==='AbortError'||error?.code==='ABORT_ERR'){this.warmStats.cancelled++;this.warmStats.lastState='已取消';return;}this.warmStats.failures++;this.warmStats.lastState='失败';this.warmStats.lastError=String(error?.code||error?.name||'unknown').slice(0,96);});this.idleTask=task;owner?.tasks.add(task);task.finally(()=>{owner?.tasks.delete(task);if(this.idleTask===task)this.idleTask=null;});},100);this.idleTimer.unref?.();});
  ctx.on('agent/inbox/inserted',({agent})=>{if(this.idleAgent?.session.id===agent.session.id)this.idleAbort?.abort();if(this.postTurnAgent?.session.id===agent.session.id)this.postTurnAbort?.abort();});
  ctx.effect(()=>async()=>{clearTimeout(this.idleTimer);clearTimeout(this.postTurnTimer);this.abortSummary();await Promise.allSettled([this.idleTask,this.postTurnTask].filter(Boolean));this.pendingTurnEnds.clear();this.postTurnBusyRetries.clear();});
 }
 abortSummary(){for(const abort of this.summaryAborts)abort.abort();this.idleAbort?.abort();this.postTurnAbort?.abort();}
 diagnostics(event,level='info',data={}){this.ctx.get('pluginDiagnostics')?.record('dsh-lossless-context',level,event,data);}

 async compactIfNeeded(agent,trigger,signal){
  const value=this.settings?.configFile.value;
  if(value?.enabled&&value.automatic===false)return null;
  if(trigger!=='pressure'||(value?.headroomMode!=='auto'&&value?.compressionTiming!=='after-turn'))return super.compactIfNeeded(agent,trigger,signal);
  const target=agent.session.requestHeader()?.config??agent.options;
  if(!target?.provider||!target?.model)return super.compactIfNeeded(agent,trigger,signal);
  const info=await this.ctx.llm.resolveModelInfo(target.provider,target.model,signal);
  if(!info.context?.contextWindow)return super.compactIfNeeded(agent,trigger,signal);
  if(value?.compressionTiming==='after-turn'){
   const policy=this.config.modelPolicies.find(row=>row.provider===target.provider&&row.model===target.model)??{};
   const budget=deferredPressureBudget({window:info.context.contextWindow,output:target.maxTokens??info.defaultMaxTokens??0,thresholdRatio:this.config.thresholdRatio,headroomTokens:value.headroomTokens,headroomMode:value.headroomMode,override:policy});
   if(this.ctx.tokenMeter.measure(agent.session).totalTokens<budget.emergencyThreshold)return null;
   this.diagnostics('compression.emergency','warn',{state:'pressure'});
  }
  if(value?.headroomMode!=='auto')return super.compactIfNeeded(agent,trigger,signal);
  const scoped=Object.create(this);
  scoped.rootEngine=this.rootEngine??this;
  scoped.config=scopedNativeConfig(this.config,{provider:target.provider,model:target.model,window:info.context.contextWindow,cap:value.headroomTokens,headroomMode:value.headroomMode});
  return BasicCompactionEngine.prototype.compactIfNeeded.call(scoped,agent,trigger,signal);
 }
 queuePostTurn(agent,delayMs=150){
  this.postTurnBusyRetries??=new Map();
  const value=this.settings?.configFile.value;
  if(!value?.enabled||!value.automatic||value.compressionTiming!=='after-turn'||!this.pendingTurnEnds.has(agent.session.id))return;
  if(this.postTurnTask||this.postTurnTimer||agent.status!=='idle'||agent.inbox?.hasPending)return;
  if(this.idleTimer){clearTimeout(this.idleTimer);this.idleTimer=null;}
  if(this.idleTask){this.idleAbort?.abort();void this.idleTask.finally(()=>this.queuePostTurn(agent));return;}
  this.postTurnTimer=setTimeout(()=>{
   this.postTurnTimer=null;
   if(agent.status!=='idle'||agent.inbox?.hasPending||!this.pendingTurnEnds.has(agent.session.id))return;
   const turnSeq=this.pendingTurnEnds.get(agent.session.id);
   this.pendingTurnEnds.delete(agent.session.id);
   const abort=new AbortController(),owner=this.settings;this.postTurnAbort=abort;this.postTurnAgent=agent;
   const task=this.runPostTurn(agent,abort.signal).catch(error=>{
    if(abort.signal.aborted||error?.code==='cancelled'||error?.name==='AbortError'){this.postTurnStatus='新消息到达，已取消后台压缩';return;}
    const code=String(error?.code||error?.name||'UNKNOWN').slice(0,64);
    const attempts=this.postTurnBusyRetries.get(agent.session.id)??0;
    if(code.toLowerCase()==='busy'&&attempts<3){
     this.postTurnBusyRetries.set(agent.session.id,attempts+1);
     if(!this.pendingTurnEnds.has(agent.session.id))this.pendingTurnEnds.set(agent.session.id,turnSeq);
     this.postTurnStatus='原生维护事务暂忙，等待下一次空闲重试';
     this.diagnostics('compression.deferred-busy-retry','warn',{attempt:attempts+1});
     return;
    }
    this.postTurnBusyRetries.delete(agent.session.id);
    this.postTurnStatus='后台压缩失败：'+code;
    this.diagnostics('compression.deferred-failed','error',{code});
   }).finally(()=>{
    owner?.tasks.delete(task);if(this.postTurnTask===task)this.postTurnTask=null;
    if(this.postTurnAbort===abort){this.postTurnAbort=null;this.postTurnAgent=null;}
    if(this.pendingTurnEnds.has(agent.session.id)&&agent.status==='idle'){
     const retries=this.postTurnBusyRetries.get(agent.session.id)??0;
     this.queuePostTurn(agent,retries?Math.min(1200*2**(retries-1),4800):150);
    }else if(!this.pendingTurnEnds.has(agent.session.id))this.postTurnBusyRetries.delete(agent.session.id);
   });
   this.postTurnTask=task;owner?.tasks.add(task);
  },delayMs);
  this.postTurnTimer.unref?.();
 }
 async runPostTurn(agent,signal){
  signal.throwIfAborted();
  if(agent.status!=='idle'||agent.inbox?.hasPending)return;
  const value=this.settings?.configFile.value,target=agent.session.requestHeader()?.config??agent.options;
  if(!value?.enabled||!value.automatic||value.compressionTiming!=='after-turn'||!target?.provider||!target?.model)return;
  const info=await this.ctx.llm.resolveModelInfo(target.provider,target.model,signal);
  if(!info.context?.contextWindow)return;
  const override=this.config.modelPolicies.find(row=>row.provider===target.provider&&row.model===target.model)??{};
  const budget=deferredPressureBudget({window:info.context.contextWindow,output:target.maxTokens??info.defaultMaxTokens??0,thresholdRatio:this.config.thresholdRatio,headroomTokens:value.headroomTokens,headroomMode:value.headroomMode,override});
  if(this.ctx.tokenMeter.measure(agent.session).totalTokens<budget.threshold){this.postTurnStatus='尚未达到任务后压缩阈值';return;}
  signal.throwIfAborted();
  const retainTokens=retainedTailTokens({window:info.context.contextWindow,output:target.maxTokens??info.defaultMaxTokens??0,config:this.config,override});
  this.postTurnStatus='任务结束后正在压缩';
  const started=performance.now(),result=await this.compactNow(agent,signal,undefined,retainTokens);
  if(result){this.postTurnStatus='任务结束后已完成压缩';this.diagnostics('compression.deferred-completed','info',{durationMs:Math.round(performance.now()-started)});}
  else this.postTurnStatus='没有可安全压缩的完整片段';
 }
 async idleMaintenance(agent){
  const settings=this.settings,value=settings?.configFile.value;if(!settings?.index||!value.enabled||!value.automatic||!value.deferred||this.idleAbort||this.postTurnTask||this.postTurnTimer||this.pendingTurnEnds.has(agent.session.id)||agent.status!=='idle'||agent.inbox.hasPending)return;
  const measurement=this.ctx.tokenMeter.measure(agent.session);if(measurement.totalTokens<4096)return;
  const config=agent.session.requestHeader()?.config;if(!config)return;
  const abort=new AbortController();this.idleAbort=abort;this.idleAgent=agent;
  try{await agent.runMaintenance(async nativeSignal=>{
   const signal=AbortSignal.any([nativeSignal,abort.signal]),info=await this.ctx.llm.resolveModelInfo(config.provider,config.model,signal);if(!info.context)return;
   const override=this.config.modelPolicies.find(policy=>policy.provider===config.provider&&policy.model===config.model)??{};
   const window=info.context.contextWindow,output=config.maxTokens??info.defaultMaxTokens??0;
   const budget=warmBudget({window,output,thresholdRatio:this.config.thresholdRatio,headroomTokens:value.headroomTokens,headroomMode:value.headroomMode,override,deferredRatio:value.deferredRatio,leafChunkTokens:value.leafChunkTokens});
   this.warmStats.lastThreshold=budget.threshold;this.warmStats.lastTrigger=budget.trigger;this.warmStats.lastHeadroom=budget.safety;
   if(budget.threshold<=0||budget.trigger<=0){this.warmStats.lastState='模型窗口余量不足';return;}
   if(measurement.totalTokens<budget.trigger){this.warmStats.lastState='等待提前预备';return;}
   this.warmStats.attempts++;this.warmStats.lastAt=Date.now();this.warmStats.lastState='正在预备';this.warmStats.lastError='';
   const retain=retainedTailTokens({window,output,config:this.config,override});
   const nodes=agent.session.surface.nodes,first=agent.session.deriveEventMessage(agent.session.eventAt(nodes[0]))?.role==='system'?1:0;let from=nodes.length,kept=0;
   for(let i=nodes.length-1;i>=first;i--){from=i;kept+=measurement.nodes[i].tokens;if(kept>=retain)break;}
   while(from>first&&(!toolPairingBalancedBefore(agent.session,nodes[from])||!toolPairingBalancedAfter(agent.session,nodes[from-1])))from--;
   if(from<=first){this.warmStats.lastState='旧上下文不足以预备';return;}
   const system=first?agent.session.deriveEventMessage(agent.session.eventAt(nodes[0])):null,input={tools:agent.session.requestHeader()?.tools,messages:[...(system?[system]:[]),...nodes.slice(first,from).map(seq=>agent.session.deriveEventMessage(agent.session.eventAt(seq))).filter(Boolean)]};
   const {plan}=await this.prepare(input,agent,signal,value),warmId='warm:'+randomUUID();let count=0,ordinal=0;
   for(const group of plan.groups){if(count>=2)break;const payload=plan.groups.length===1?input:{...input,messages:[...(plan.system?[plan.system]:[]),...group.messages]},key=this.cacheKey(payload,agent,'leaf');if(this.cached(key,agent.session.id)){this.warmStats.hits++;continue;}
    signal.throwIfAborted();const started=performance.now(),result=await this.completeSummary(payload,agent,signal,value,metadata=>settings.index.auxiliary(agent.session.id,warmId,ordinal++,'truncated',metadata),'leaf');signal.throwIfAborted();
    settings.index.auxiliary(agent.session.id,warmId,ordinal++,'warm-leaf',{provider:result.provider,model:result.model,maxTokens:result.maxTokens,usage:result.usage??null,durationMs:Math.round(performance.now()-started),estimatedOutputTokens:this.ctx.tokenMeter.estimateMessage({role:'assistant',content:result.summary})});count++;this.remember(key,result,warmId,agent.session.id);
   }
   this.warmStats.prepared+=count;this.warmStats.lastState=count?'已预备 '+count+' 个叶摘要':'缓存已命中或没有可预备片段';
   this.diagnostics('warm.completed','info',{durationMs:Date.now()-this.warmStats.lastAt,prepared:count,cacheHits:this.warmStats.hits});
  });}finally{if(this.idleAbort===abort){this.idleAbort=null;this.idleAgent=null;}}
 }
 cacheKey(input,agent,kind='leaf'){
  const value=this.settings?.configFile.value;
  // Domain-separate leaves and condensed nodes, and bind every summary-shaping policy.
  const policy={...this.config,headroomTokens:0,kind,leafTargetTokens:value?.leafTargetTokens??2400,condensedTargetTokens:value?.condensedTargetTokens??2000,summaryGuidance:value?.summaryGuidance??'',summaryRetryMaxTokens:value?.summaryRetryMaxTokens??32768};
  return createHash('sha256').update(JSON.stringify(['lcm-complete-summary-v2',agent.session.id,agent.session.requestHeader()?.config??agent.options,policy,input])).digest('hex');
 }
 cached(key,sessionId){
  const row=this.warmed.get(key);
  if(row&&Date.now()-row.at<=1800000)return row;
  if(row)this.warmed.delete(key);
  try{
   const persisted=this.settings?.index?.cacheGet(sessionId,key);
   if(persisted){this.warmed.set(key,persisted);return persisted;}
  }catch(error){this.diagnostics('cache.read-failed','warn',{code:String(error?.code??error?.name??'UNKNOWN').slice(0,64)});}
  return null;
 }
 remember(key,result,source,sessionId){
  this.warmed.set(key,{result,source,at:Date.now()});
  while(this.warmed.size>64)this.warmed.delete(this.warmed.keys().next().value);
  try{this.settings?.index?.cachePut(sessionId,key,result,source);}
  catch(error){this.diagnostics('cache.persist-failed','warn',{code:String(error?.code??error?.name??'UNKNOWN').slice(0,64)});}
 }
 completeSummary(input,agent,signal,value,onTruncated,kind){return summarizeComplete(BasicCompactionEngine.prototype.summarize,this.ctx,this.config,input,agent,signal,{...value,kind:kind??'leaf',summaryGuidance:value.summaryGuidance,compressionTimeoutMs:value.compressionTimeoutMs,compressionMaxRetries:value.compressionMaxRetries,onTruncated,onTimeout:info=>this.ctx.get('pluginDiagnostics')?.record('dsh-lossless-context','warn','compression.timeout',info),onTransient:info=>this.ctx.get('pluginDiagnostics')?.record('dsh-lossless-context','warn','compression.transport-retry',info)});}
 summarize(input,agent,signal){
  const settings=this.settings,value=settings?.configFile.value;
  if(!settings?.index||!value.enabled)return super.summarize(input,agent,signal);
  const abort=new AbortController();this.summaryAborts.add(abort);const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  const operation=this.summarizeLossless(input,agent,combined,settings,value);
  settings.tasks.add(operation);
  return operation.finally(()=>{const owner=this.rootEngine??this;settings.tasks.delete(operation);owner.summaryAborts.delete(abort);if(owner.pendingConfig&&!owner.summaryAborts.size){owner.config=owner.pendingConfig;owner.pendingConfig=null;}});
 }
 async prepare(input,agent,signal,value){
  const routed=agent.session.requestHeader()?.config??agent.options,override=this.config.modelPolicies.find(policy=>policy.provider===routed.provider&&policy.model===routed.model)??{};
  const provider=(override.summarizationProvider??this.config.summarizationProvider)||routed.provider,model=(override.summarizationModel??this.config.summarizationModel)||routed.model;
  const info=await this.ctx.llm.resolveModelInfo(provider,model,signal),system=input.messages[0]?.role==='system'?input.messages[0]:null;
  const overhead=(system?this.ctx.tokenMeter.estimateMessage(system):0)+Math.ceil(JSON.stringify(input.tools??[]).length/3)+2000;
  const initial=override.maxTokens??this.config.maxTokens,window=info.context?.contextWindow;
  const requested=value.summaryRetries?Math.max(initial,Math.min(value.summaryRetryMaxTokens,Math.floor(window/4))):initial;
  const afterOverhead=window-overhead-Math.min(4096,Math.ceil(window*0.1));
  const reserve=Math.floor(Math.min(requested,info.context?.maxOutputTokens??Infinity,afterOverhead/2));
  if(reserve<128)throw new Error('lcm-summary-model-budget-too-small');
  const {available}=summaryBudget(info,reserve,overhead);
  const plan=leafPlan(input,this.ctx.tokenMeter,Math.min(value.leafChunkTokens,available));
  if(plan.groups.length>256||plan.groups.some(group=>group.tokens>available))throw new Error('lcm-leaf-exceeds-summary-model-budget');
  return {plan,available};
 }
 async summarizeLossless(input,agent,signal,settings,value){
  const index=settings.index;index.sync(agent.session);const compactionId=index.active(agent.session.id);if(!compactionId)throw new Error('lcm-native-compaction-marker-missing');
  const compressionStarted=performance.now();
  this.diagnostics('compression.started','info',{sessionId:agent.session.id,provider:agent.session.requestHeader()?.config?.provider,model:agent.session.requestHeader()?.config?.model,inputMessages:input.messages.length});
  let plan,available;
  try{({plan,available}=await this.prepare(input,agent,signal,value));}
  catch(error){this.diagnostics('compression.failed','error',{stage:'prepare',code:error?.code||error?.name,error:String(error?.message||error)});throw error;}
  const leaves=[];let ordinal=0;
  const run=async(payload,kind)=>{
   signal.throwIfAborted();const started=performance.now(),key=this.cacheKey(payload,agent,kind),cached=this.cached(key,agent.session.id);let result;
   try{result=cached?{...cached.result,usage:undefined,rawOutput:undefined,llmStreamCall:false}:await this.completeSummary(payload,agent,signal,value,metadata=>index.auxiliary(agent.session.id,compactionId,ordinal++,'truncated',metadata),kind);}
   catch(error){this.diagnostics('compression.failed','error',{stage:kind,code:error?.code||error?.name,error:String(error?.message||error)});throw error;}
   signal.throwIfAborted();if(kind==='leaf'){this.warmStats.leafRequests++;if(cached)this.warmStats.leafHits++;}if(cached)this.warmStats.hits++;index.auxiliary(agent.session.id,compactionId,ordinal++,kind,{provider:result.provider,model:result.model,maxTokens:result.maxTokens,usage:result.usage??null,cachedFrom:cached?.source??null,estimatedOutputTokens:this.ctx.tokenMeter.estimateMessage({role:'assistant',content:result.summary}),durationMs:Math.round(performance.now()-started)});if(!cached)this.remember(key,result,compactionId,agent.session.id);return result;
  };
  if(plan.groups.length===1){const result=await run(input,'leaf');index.plan(agent.session.id,compactionId,{leaves:[{start:0,end:plan.groups[0].end,summary:summaryText(result)}]});this.diagnostics('compression.completed','info',{durationMs:Math.round(performance.now()-compressionStarted),leafCount:1});return this.withRecallHint(result,value);}
  for(const group of plan.groups){const result=await run({...input,messages:[...(plan.system?[plan.system]:[]),...group.messages]},'leaf');leaves.push({...group,messages:undefined,summary:summaryText(result),result});}
  const dag={leaves:leaves.map(({start,end,summary})=>({start,end,summary})),branches:[],rootChildren:[]};
  let layer=leaves.map((leaf,index)=>({id:'leaf:'+index,text:leaf.summary,result:leaf.result}));
  while(layer.length>1){
   const next=[];for(let start=0;start<layer.length;){
    const group=[];let tokens=0;
    while(start<layer.length&&group.length<value.condenseFanout){const candidate=layer[start],cost=this.ctx.tokenMeter.estimateMessage({role:'user',content:[{type:'text',text:candidate.text}]});if(group.length&&tokens+cost>available)break;group.push(candidate);tokens+=cost;start++;}
    if(group.length===1){next.push(group[0]);continue;}
    const result=await run({...input,messages:[...(plan.system?[plan.system]:[]),{role:'user',content:[{type:'text',text:group.map((leaf,index)=>`摘要 ${index+1}:\n${leaf.text}`).join('\n\n')}]}]},'condensed');const id='branch:'+dag.branches.length,children=group.map(leaf=>leaf.id);dag.branches.push({id,children,summary:summaryText(result)});next.push({id,text:summaryText(result),result});
   }if(next.length>=layer.length)throw new Error('lcm-condensed-summary-does-not-fit');layer=next;
  }
  const root=dag.branches.pop();dag.rootChildren=root.children;index.plan(agent.session.id,compactionId,dag);
  this.diagnostics('compression.completed','info',{sessionId:agent.session.id,durationMs:Math.round(performance.now()-compressionStarted),leafCount:plan.groups.length,branchCount:dag.branches.length+1});
  const result=layer[0].result;
  return this.withRecallHint(result,value);
 }
 withRecallHint(result,value){return value.promptAwareRecall?{...result,summary:[...result.summary,{type:'text',text:'需要精确原文时，可用 lcm_grep 检索当前会话，或 lcm_describe / lcm_expand 按摘要节点展开；超长工具原文可通过 DSH 提供的完整结果文件读取。'}]}:result;}
}
