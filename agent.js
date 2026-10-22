import { BasicCompactionEngine } from './native/basic-compaction-rc2.js';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { nativeConfig } from './config.js';
import { externalizeLargeBlocks,leafPlan,summaryBudget,summaryEnvelope,summaryText } from './planner.js';
import { installRecall } from './recall.js';
import { summarizeComplete } from './summarizer.js';
import { warmBudget,scopedNativeConfig,deferredPressureBudget,retainedTailTokens } from './pressure.js';

/** Preserve safe failure codes without persisting model output or provider messages. */
export function summaryFailureCode(error){
 const code=typeof error?.code==='string'?error.code:'';
 if(/^[A-Z][A-Z0-9_]{1,31}$/.test(code))return code;
 const message=String(error?.message??'');
 if(message==='summarization produced no text summary content')return 'SUMMARY_EMPTY';
 if(message.startsWith('summarization truncated at the token cap'))return 'MAX_TOKENS';
 if(message==='lcm-summary-model-budget-too-small')return 'SUMMARY_BUDGET';
 return 'SUMMARY_UNKNOWN';
}

/** Preset-scoped native backend; all surface commits and replay stay native. */
// Both the idle preparation and the committed compaction must build byte-identical
// payloads, otherwise the warmed cache key never matches and the preparation is
// silently wasted. These helpers are the single source of truth for that shape.
export const condensedLabel = texts => texts.map((text, index) => `摘要 ${index + 1}:\n${text}`).join('\n\n');
const systemFirst = (plan, rest) => [...(plan?.system ? [plan.system] : []), ...rest];
export const leafPayload = (input, plan, group) =>
  plan.groups.length === 1 ? input : { ...input, messages: systemFirst(plan, group.messages) };
export const condensedPayload = (input, plan, texts) =>
  ({ ...input, messages: systemFirst(plan, [{ role: 'user', content: [{ type: 'text', text: condensedLabel(texts) }] }]) });
/** Group one summary layer by fanout and the remaining token budget. */
export const groupLayer = (layer, { fanout, available, estimate }) => {
  const groups = [];
  for (let start = 0; start < layer.length;) {
    const group = [];
    let tokens = 0;
    while (start < layer.length && group.length < fanout) {
      const candidate = layer[start], cost = estimate(candidate);
      if (group.length && tokens + cost > available) break;
      group.push(candidate); tokens += cost; start++;
    }
    groups.push(group);
  }
  return groups;
};
/** A layer that cannot shrink is a structural stop, not a transient model failure. */
export const notFitError = () => Object.assign(new Error('condensed summary does not shrink the layer'), { code: 'lcm-condensed-summary-does-not-fit' });

export default class LosslessCompaction extends BasicCompactionEngine {
 static inject=BasicCompactionEngine.inject;
 constructor(ctx,config={}){
  const settings=ctx.get('losslessContext');super(ctx,settings?nativeConfig(settings.configFile.value):config);
  this.settings=null;this.pendingConfig=null;this.summaryAborts=new Set();this.idleAbort=null;this.idleAgent=null;this.idleTimer=null;this.idleTask=null;this.warmContinuation=null;this.warmCampaigns=new Map();this.pendingTurnEnds=new Map();this.postTurnAgents=new Map();this.postTurnBusyRetries=new Map();this.postTurnRetryAt=new Map();this.postTurnTimer=null;this.postTurnTask=null;this.postTurnAbort=null;this.postTurnAgent=null;this.postTurnStatus='尚未执行';this.warmed=new Map();this.warmStats={attempts:0,prepared:0,hits:0,leafRequests:0,leafHits:0,failures:0,cancelled:0,lastState:'未开始',lastError:'',lastAt:0,lastThreshold:0,lastTrigger:0,lastHeadroom:0,warmHits:0};
  ctx.inject(['losslessContext'],scope=>{
   const owner=scope.losslessContext;this.settings=owner;owner.engines.add(this);
   const update=()=>{this.warmed.clear();this.warmContinuation=null;this.warmCampaigns.clear();clearTimeout(this.idleTimer);this.idleTimer=null;this.idleAbort?.abort();this.postTurnAbort?.abort();const value=nativeConfig(owner.configFile.value);if(this.summaryAborts.size)this.pendingConfig=value;else this.config=value;};update();
   const unsubscribe=owner.configFile.subscribe(update),recall=installRecall(scope,()=>this.settings?.index,()=>this.settings?.configFile.value);
   scope.effect(()=>()=>{unsubscribe();recall?.dispose?.();owner.engines.delete(this);this.abortSummary();if(this.settings===owner)this.settings=null;});
  });
  ctx.on('session/event',(session,event)=>{if(event.type!=='turn/end'||!Number.isSafeInteger(event.seq)||!this.settings?.configFile.value.enabled||!this.settings.configFile.value.automatic||this.settings.configFile.value.compressionTiming!=='after-turn')return;this.postTurnBusyRetries.delete(session.id);this.postTurnRetryAt?.delete(session.id);this.pendingTurnEnds.set(session.id,event.seq);if(this.pendingTurnEnds.size>500){const oldest=this.pendingTurnEnds.keys().next().value;this.pendingTurnEnds.delete(oldest);this.postTurnAgents?.delete(oldest);}const agent=ctx.get('agents')?.get(session.id);if(agent)this.queuePostTurn(agent);});
  ctx.on('agent/status',({agent,status})=>{if(status!=='idle'||!agent?.session)return;if(this.pendingTurnEnds.has(agent.session.id)&&this.settings?.configFile.value.compressionTiming==='after-turn'){this.queuePostTurn(agent);return;}this.scheduleIdleWarm(agent);});
  // Native maintenance owns admission: new messages queue behind a running compaction.
  // Only speculative warming is preemptible; never abort committed post-turn work.
  ctx.on('agent/inbox/inserted',({agent})=>{if(this.idleTimer){clearTimeout(this.idleTimer);this.idleTimer=null;}if(this.warmContinuation?.session?.id===agent.session.id)this.warmContinuation=null;this.warmCampaigns.delete(agent.session.id);if(this.idleAgent?.session.id===agent.session.id)this.idleAbort?.abort();});
  ctx.effect(()=>async()=>{clearTimeout(this.idleTimer);clearTimeout(this.postTurnTimer);this.abortSummary();await Promise.allSettled([this.idleTask,this.postTurnTask].filter(Boolean));this.pendingTurnEnds.clear();this.postTurnAgents?.clear();this.postTurnRetryAt?.clear();this.postTurnBusyRetries.clear();});
 }
 abortSummary(){for(const abort of this.summaryAborts)abort.abort();this.idleAbort?.abort();this.postTurnAbort?.abort();}
 diagnostics(event,level='info',data={}){this.ctx.get('pluginDiagnostics')?.record('dsh-lossless-context',level,event,data);}

 scheduleIdleWarm(agent,delayMs=100){
  const value=this.settings?.configFile.value;
  if(!value?.enabled||!value.automatic||!value.deferred||!agent||agent.status!=='idle'||agent.inbox?.hasPending||this.pendingTurnEnds.size||this.idleTimer||this.idleTask||this.postTurnTimer||this.postTurnTask)return;
  const sessionId=agent.session.id,attempts=this.warmCampaigns.get(sessionId)??0;
  if(attempts>=3)return; // At most six summary nodes per uninterrupted idle period.
  this.warmCampaigns.set(sessionId,attempts+1);
  if(this.warmCampaigns.size>256)this.warmCampaigns.delete(this.warmCampaigns.keys().next().value);
  this.idleTimer=setTimeout(()=>{
   this.idleTimer=null;
   const owner=this.settings;
   const task=this.idleMaintenance(agent).then(pending=>{if(pending)this.warmContinuation=agent;}).catch(error=>{
    if(error?.name==='AbortError'||error?.code==='ABORT_ERR'){this.warmStats.cancelled++;this.warmStats.lastState='已取消';return;}
    this.warmStats.failures++;this.warmStats.lastState='失败';this.warmStats.lastError=String(error?.code||error?.name||'unknown').slice(0,96);
   });
   this.idleTask=task;owner?.tasks.add(task);
   void task.finally(()=>{
    owner?.tasks.delete(task);
    if(this.idleTask===task)this.idleTask=null;
    if(this.warmContinuation===agent){this.warmContinuation=null;this.scheduleIdleWarm(agent,1200);}
   });
  },delayMs);
  this.idleTimer.unref?.();
 }


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
  const value=this.settings?.configFile.value;
  if(!value?.enabled||!value.automatic||value.compressionTiming!=='after-turn'||!this.pendingTurnEnds.has(agent.session.id))return;
  this.postTurnAgents??=new Map();
  this.postTurnBusyRetries??=new Map();
  this.postTurnRetryAt??=new Map();
  this.postTurnAgents.set(agent.session.id,agent);
  if(this.idleTimer){clearTimeout(this.idleTimer);this.idleTimer=null;}
  if(this.idleTask){this.idleAbort?.abort();void this.idleTask.finally(()=>this.schedulePostTurns());return;}
  this.schedulePostTurns(delayMs);
 }
 /** Do not confuse the public idle status with the private maintenance phase.
  * A busy maintenance lease is not an error: keep the turn queued until the
  * agent transitions to idle (with a slow bounded fallback wakeup).
  */
 schedulePostTurns(delayMs=150){
  if(this.postTurnTask||this.postTurnTimer||!this.pendingTurnEnds?.size)return;
  this.postTurnTimer=setTimeout(()=>{this.postTurnTimer=null;this.startPendingPostTurn();},delayMs);
  this.postTurnTimer.unref?.();
 }
 startPendingPostTurn(){
  if(this.postTurnTask)return;
  if(this.idleTask){this.idleAbort?.abort();void this.idleTask.finally(()=>this.schedulePostTurns());return;}
  this.postTurnAgents??=new Map();
  this.postTurnRetryAt??=new Map();
  this.postTurnBusyRetries??=new Map();
  const now=Date.now();
  let agent=null,turnSeq=null;
  let waitMs=Infinity;
  for(const [id,seq] of this.pendingTurnEnds){
   const candidate=this.postTurnAgents.get(id);
   if(!candidate)continue;
   // Runtime reports maintenance as "idle"; the native lease only accepts
   // phase.kind === idle. Keep the work pending rather than racing the lease.
   if(candidate.status!=='idle'||candidate.inbox?.hasPending)continue;
   if(candidate.phase?.kind&&candidate.phase.kind!=='idle'){
    waitMs=Math.min(waitMs,3000);continue;
   }
   const retryAt=this.postTurnRetryAt.get(id)??0;
   if(retryAt>now){waitMs=Math.min(waitMs,retryAt-now);continue;}
   agent=candidate;turnSeq=seq;break;
  }
  if(!agent){if(Number.isFinite(waitMs))this.schedulePostTurns(Math.max(100,waitMs));return;}
  const id=agent.session.id;
  this.pendingTurnEnds.delete(id);
  this.postTurnAgents.delete(id);
  const abort=new AbortController(),owner=this.settings;
  this.postTurnAbort=abort;this.postTurnAgent=agent;
  const task=this.runPostTurn(agent,abort.signal).then(()=>{
   this.postTurnBusyRetries.delete(id);this.postTurnRetryAt.delete(id);
  }).catch(error=>{
   if(abort.signal.aborted||error?.code==='cancelled'||error?.name==='AbortError'){
    this.postTurnStatus='后台压缩已取消';
    // Native maintenance cancellation on new work is handled by the next turn/end.
    return;
   }
   const code=String(error?.code||error?.name||'UNKNOWN').slice(0,64);
   if(code.toLowerCase()==='busy'){
    const attempts=(this.postTurnBusyRetries.get(id)??0)+1;
    this.postTurnBusyRetries.set(id,attempts);
    const backoff=Math.min(500*Math.pow(2,Math.min(attempts-1,4)),8000);
    this.postTurnRetryAt.set(id,Date.now()+backoff);
    if(!this.pendingTurnEnds.has(id))this.pendingTurnEnds.set(id,turnSeq);
    this.postTurnAgents.set(id,agent);
    this.postTurnStatus='原生维护事务暂忙，等待空闲后压缩';
    this.diagnostics('compression.deferred-busy-retry','warn',{count:attempts,durationMs:backoff});
    return;
   }
   this.postTurnBusyRetries.delete(id);this.postTurnRetryAt.delete(id);
   this.postTurnStatus='后台压缩失败：'+code;
   this.diagnostics('compression.deferred-failed','error',{code});
  }).finally(()=>{
   owner?.tasks.delete(task);
   if(this.postTurnTask===task)this.postTurnTask=null;
   if(this.postTurnAbort===abort){this.postTurnAbort=null;this.postTurnAgent=null;}
   // Drain every pending session, not just the session that just finished.
   this.schedulePostTurns();
  });
  this.postTurnTask=task;owner?.tasks.add(task);
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

 /** Prepare exactly the same leaf/condensed payloads as the native transaction, without committing. */
 async warmPrepared(input,agent,signal,value,index,warmId,limit=2){
  const preparedInput=await this.prepare(input,agent,signal,value);
  const {plan,available}=preparedInput;
  if(preparedInput.input)input=preparedInput.input;
  let prepared=0,cacheHits=0,ordinal=0;
  const get=async(payload,kind)=>{
   signal.throwIfAborted();
   const key=this.cacheKey(payload,agent,kind),cached=this.cached(key,agent.session.id);
   if(cached){cacheHits++;return cached.result;}
   if(prepared>=limit)return null;
   const started=performance.now();
   const result=await this.completeSummary(payload,agent,signal,value,metadata=>index.auxiliary(agent.session.id,warmId,ordinal++,'truncated',metadata),kind);
   signal.throwIfAborted();
   const durationMs=Math.round(performance.now()-started);
   index.auxiliary(agent.session.id,warmId,ordinal++,'warm-'+kind,{provider:result.provider,model:result.model,maxTokens:result.maxTokens,usage:result.usage??null,durationMs,estimatedOutputTokens:this.ctx.tokenMeter.estimateMessage({role:'assistant',content:result.summary})});
   this.remember(key,result,warmId,agent.session.id);
   this.diagnostics('warm.stage','info',{kind,durationMs});
   prepared++;
   return result;
  };
  const layer=[];
  for(const group of plan.groups){
   const result=await get(leafPayload(input,plan,group),'leaf');
   if(!result)return {prepared,cacheHits,pending:true,leafCount:plan.groups.length};
   layer.push({text:summaryText(result)});
  }
  if(layer.length<=1)return {prepared,cacheHits,pending:false,leafCount:layer.length};
  const estimate=item=>this.ctx.tokenMeter.estimateMessage({role:'user',content:[{type:'text',text:item.text}]});
  let current=layer;
  while(current.length>1){
   const next=[];
   for(const group of groupLayer(current,{fanout:value.condenseFanout,available,estimate})){
    if(group.length===1){next.push(group[0]);continue;}
    const result=await get(condensedPayload(input,plan,group.map(item=>item.text)),'condensed');
    if(!result)return {prepared,cacheHits,pending:true,leafCount:plan.groups.length};
    next.push({text:summaryText(result)});
   }
   if(next.length>=current.length){
    this.diagnostics('warm.condensed-not-fit','warn',{layer:current.length,code:'lcm-condensed-summary-does-not-fit'});
    return {prepared,cacheHits,pending:false,leafCount:plan.groups.length,stopped:'not-fit'};
   }
   current=next;
  }
  return {prepared,cacheHits,pending:false,leafCount:plan.groups.length};
 }

 async idleMaintenance(agent){
  const settings=this.settings,value=settings?.configFile.value;
  if(!settings?.index||!value.enabled||!value.automatic||!value.deferred||this.idleAbort||this.postTurnTask||this.postTurnTimer||this.pendingTurnEnds.size||agent.status!=='idle'||(agent.phase?.kind&&agent.phase.kind!=='idle')||agent.inbox.hasPending)return false;
  const measurement=this.ctx.tokenMeter.measure(agent.session);if(measurement.totalTokens<4096)return false;
  const config=agent.session.requestHeader()?.config;if(!config)return false;
  const abort=new AbortController();this.idleAbort=abort;this.idleAgent=agent;
  try{
   return await agent.runMaintenance(async nativeSignal=>{
    const signal=AbortSignal.any([nativeSignal,abort.signal]);
    const info=await this.ctx.llm.resolveModelInfo(config.provider,config.model,signal);if(!info.context)return false;
    const override=this.config.modelPolicies.find(policy=>policy.provider===config.provider&&policy.model===config.model)??{};
    const window=info.context.contextWindow,output=config.maxTokens??info.defaultMaxTokens??0;
    const budget=warmBudget({window,output,thresholdRatio:this.config.thresholdRatio,headroomTokens:value.headroomTokens,headroomMode:value.headroomMode,override,deferredRatio:value.deferredRatio,leafChunkTokens:value.leafChunkTokens});
    this.warmStats.lastThreshold=budget.threshold;this.warmStats.lastTrigger=budget.trigger;this.warmStats.lastHeadroom=budget.safety;
    if(budget.threshold<=0||budget.trigger<=0){this.warmStats.lastState='模型窗口余量不足';return false;}
    if(measurement.totalTokens<budget.trigger){this.warmStats.lastState='等待提前预备';return false;}
    this.warmStats.attempts++;this.warmStats.lastAt=Date.now();this.warmStats.lastState='正在预备';this.warmStats.lastError='';
    const retain=retainedTailTokens({window,output,config:this.config,override});
    const nodes=agent.session.surface.nodes,first=agent.session.deriveEventMessage(agent.session.eventAt(nodes[0]))?.role==='system'?1:0;let from=nodes.length,kept=0;
    for(let i=nodes.length-1;i>=first;i--){from=i;kept+=measurement.nodes[i].tokens;if(kept>=retain)break;}
    while(from>first&&(!toolPairingBalancedBefore(agent.session,nodes[from])||!toolPairingBalancedAfter(agent.session,nodes[from-1])))from--;
    if(from<=first){this.warmStats.lastState='旧上下文不足以预备';return false;}
    const system=first?agent.session.deriveEventMessage(agent.session.eventAt(nodes[0])):null;
    const input={tools:agent.session.requestHeader()?.tools,messages:[...(system?[system]:[]),...nodes.slice(first,from).map(seq=>agent.session.deriveEventMessage(agent.session.eventAt(seq))).filter(Boolean)]};
    const result=await this.warmPrepared(input,agent,signal,value,settings.index,'warm:'+randomUUID());
    signal.throwIfAborted();
    this.warmStats.prepared+=result.prepared;this.warmStats.warmHits+=result.cacheHits;
    this.warmStats.lastState=result.stopped==='not-fit'?'摘要层无法再收缩，已停止预备':result.pending?'已预备 '+result.prepared+' 个，空闲时继续':'已完成当前可压缩片段的预备';
    this.diagnostics('warm.completed','info',{durationMs:Date.now()-this.warmStats.lastAt,prepared:result.prepared,cacheHits:result.cacheHits,warmHits:this.warmStats.warmHits,stopped:result.stopped??null,pending:result.pending,leafCount:result.leafCount});
    return result.pending&&result.prepared>0;
   });
  }finally{if(this.idleAbort===abort){this.idleAbort=null;this.idleAgent=null;}}
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
 /** Replace oversized text blocks with content-addressed references before planning. */
 externalizeInput(input,agent,value){
  const threshold=Number(value?.largeFileCharsThreshold??0);
  if(!(threshold>0))return input;
  const index=this.settings?.index;
  if(!index)return input;
  const {messages,files}=externalizeLargeBlocks(input.messages,{thresholdChars:threshold});
  if(!files.length)return input;
  try{
   const dir=index.fileDir(agent.session.id);
   for(const file of files){
    const target=path.join(dir,file.id+'.txt');
    if(!existsSync(target))writeFileSync(target,file.text,'utf8');
    index.putFile({sessionId:agent.session.id,id:file.id,chars:file.chars,filePath:target,excerpt:file.text.slice(0,8192)});
   }
   this.diagnostics('compression.externalized','info',{files:files.length,chars:files.reduce((total,file)=>total+file.chars,0)});
  }catch(error){
   // Never drop content just because externalisation failed: keep the original input.
   this.diagnostics('compression.externalize-failed','warn',{code:String(error?.code??error?.name??'unknown').slice(0,64)});
   return input;
  }
  return {...input,messages};
 }
 async prepare(input,agent,signal,value){
  input=this.externalizeInput(input,agent,value);
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
  return {plan,available,input};
 }
 async summarizeLossless(input,agent,signal,settings,value){
  const index=settings.index;index.sync(agent.session);const compactionId=index.active(agent.session.id);if(!compactionId)throw new Error('lcm-native-compaction-marker-missing');
  const compressionStarted=performance.now();
  this.diagnostics('compression.started','info',{sessionId:agent.session.id,provider:agent.session.requestHeader()?.config?.provider,model:agent.session.requestHeader()?.config?.model,inputMessages:input.messages.length});
  let plan,available;
  try{const prepared=await this.prepare(input,agent,signal,value);plan=prepared.plan;available=prepared.available;input=prepared.input??input;}
  catch(error){const code=summaryFailureCode(error);this.diagnostics('compression.failed','error',{code});this.diagnostics('compression.prepare-failed','error',{code});throw error;}
  const stage={prepareMs:Math.round(performance.now()-compressionStarted),leafCount:0,branchCount:0,cacheHits:0,modelCalls:0,modelMs:0};
  this.diagnostics('compression.plan','info',{prepareMs:stage.prepareMs,leafCount:plan.groups.length,inputMessages:input.messages.length});
  const leaves=[];let ordinal=0;
  const run=async(payload,kind)=>{
   signal.throwIfAborted();const started=performance.now(),key=this.cacheKey(payload,agent,kind),cached=this.cached(key,agent.session.id);let result;
   try{result=cached?{...cached.result,usage:undefined,rawOutput:undefined,llmStreamCall:false}:await this.completeSummary(payload,agent,signal,value,metadata=>index.auxiliary(agent.session.id,compactionId,ordinal++,'truncated',metadata),kind);}
   catch(error){const code=summaryFailureCode(error);this.diagnostics('compression.failed','error',{code});this.diagnostics(kind==='condensed'?'compression.condensed-failed':'compression.leaf-failed','error',{code});throw error;}
   signal.throwIfAborted();const durationMs=Math.round(performance.now()-started);
   if(kind==='leaf'){stage.leafCount++;this.warmStats.leafRequests++;if(cached)this.warmStats.leafHits++;}else stage.branchCount++;
   if(cached){stage.cacheHits++;this.warmStats.hits++;}else{stage.modelCalls++;stage.modelMs+=durationMs;}
   index.auxiliary(agent.session.id,compactionId,ordinal++,kind,{provider:result.provider,model:result.model,maxTokens:result.maxTokens,usage:result.usage??null,cachedFrom:cached?.source??null,estimatedOutputTokens:this.ctx.tokenMeter.estimateMessage({role:'assistant',content:result.summary}),durationMs});
   if(!cached)this.remember(key,result,compactionId,agent.session.id);
   this.diagnostics('compression.stage','info',{kind,cacheHit:!!cached,durationMs});return result;
  };
  if(plan.groups.length===1){const result=await run(input,'leaf');index.plan(agent.session.id,compactionId,{leaves:[{start:0,end:plan.groups[0].end,summary:summaryText(result)}]});this.diagnostics('compression.completed','info',{durationMs:Math.round(performance.now()-compressionStarted),...stage});return this.withRecallHint(result,value,{id:compactionId,kind:'leaf',depth:0,sources:input.messages.length||plan.groups[0].end,descendants:1});}
  for(const group of plan.groups){const result=await run({...input,messages:[...(plan.system?[plan.system]:[]),...group.messages]},'leaf');leaves.push({...group,messages:undefined,summary:summaryText(result),result});}
  const dag={leaves:leaves.map(({start,end,summary})=>({start,end,summary})),branches:[],rootChildren:[]};
  let layer=leaves.map((leaf,index)=>({id:'leaf:'+index,text:leaf.summary,result:leaf.result}));
  const estimate=item=>this.ctx.tokenMeter.estimateMessage({role:'user',content:[{type:'text',text:item.text}]});
  while(layer.length>1){
   const next=[];
   for(const group of groupLayer(layer,{fanout:value.condenseFanout,available,estimate})){
    if(group.length===1){next.push(group[0]);continue;}
    const result=await run(condensedPayload(input,plan,group.map(item=>item.text)),'condensed');
    const id='branch:'+dag.branches.length,children=group.map(leaf=>leaf.id);dag.branches.push({id,children,summary:summaryText(result)});next.push({id,text:summaryText(result),result});
   }
   if(next.length>=layer.length){
    const error=notFitError();
    this.diagnostics('compression.condensed-not-fit','error',{layer:layer.length,code:error.code});
    throw error;
   }
   layer=next;
  }
  const root=dag.branches.pop();dag.rootChildren=root.children;index.plan(agent.session.id,compactionId,dag);
  this.diagnostics('compression.completed','info',{durationMs:Math.round(performance.now()-compressionStarted),...stage});
  const result=layer[0].result;
  return this.withRecallHint(result,value,{id:compactionId,kind:'condensed',depth:Math.max(1,dag.branches.length),sources:leaves.reduce((total,leaf)=>total+Math.max(0,(leaf.end??0)-(leaf.start??0)),0),descendants:leaves.length});
 }
 withRecallHint(result,value,meta={}){
  const hint=value.promptAwareRecall?'需要精确原文时，可用 lcm_recall（action=search/describe/expand）；上面的 id 可直接用于 describe 或 expand。超长工具原文可通过 DSH 提供的完整结果文件读取。':'';
  const body=hint?summaryText(result)+'\n\n'+hint:summaryText(result);
  return {...result,summary:[{type:'text',text:summaryEnvelope({...meta,text:body})}]};
 }
}
