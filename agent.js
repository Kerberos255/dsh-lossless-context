import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic';
import { toolPairingBalancedBefore, toolPairingBalancedAfter } from '@deepseek-ai/dsh-compaction';
import { createHash, randomUUID } from 'node:crypto';
import { nativeConfig } from './config.js';
import { leafPlan,summaryBudget,summaryText } from './planner.js';
import { installRecall } from './recall.js';
import { summarizeComplete } from './summarizer.js';

/** Preset-scoped native backend; all surface commits and replay stay native. */
export default class LosslessCompaction extends BasicCompactionEngine {
 static inject=BasicCompactionEngine.inject;
 constructor(ctx,config={}){
  const settings=ctx.get('losslessContext');super(ctx,settings?nativeConfig(settings.configFile.value):config);
  this.settings=null;this.pendingConfig=null;this.summaryAborts=new Set();this.idleAbort=null;this.idleAgent=null;this.idleTimer=null;this.idleTask=null;this.warmed=new Map();
  ctx.inject(['losslessContext'],scope=>{
   const owner=scope.losslessContext;this.settings=owner;owner.engines.add(this);
   const update=()=>{this.warmed.clear();this.idleAbort?.abort();const value=nativeConfig(owner.configFile.value);if(this.summaryAborts.size)this.pendingConfig=value;else this.config=value;};update();
   const unsubscribe=owner.configFile.subscribe(update),recall=installRecall(scope,()=>this.settings?.index,()=>this.settings?.configFile.value);
   scope.effect(()=>()=>{unsubscribe();recall?.dispose?.();owner.engines.delete(this);this.abortSummary();if(this.settings===owner)this.settings=null;});
  });
  ctx.on('agent/status',({agent,status})=>{if(status!=='idle'||this.idleTimer||this.idleTask||!this.settings?.configFile.value.deferred)return;this.idleTimer=setTimeout(()=>{this.idleTimer=null;const owner=this.settings,task=this.idleMaintenance(agent).catch(()=>{});this.idleTask=task;owner?.tasks.add(task);task.finally(()=>{owner?.tasks.delete(task);if(this.idleTask===task)this.idleTask=null;});},100);this.idleTimer.unref?.();});
  ctx.on('agent/inbox/inserted',({agent})=>{if(this.idleAgent?.session.id===agent.session.id)this.idleAbort?.abort();});
  ctx.effect(()=>async()=>{clearTimeout(this.idleTimer);this.abortSummary();await this.idleTask?.catch(()=>{});});
 }
 abortSummary(){for(const abort of this.summaryAborts)abort.abort();this.idleAbort?.abort();}
 compactIfNeeded(agent,trigger,signal){if(this.settings?.configFile.value.enabled&&this.settings.configFile.value.automatic===false)return Promise.resolve(null);return super.compactIfNeeded(agent,trigger,signal);}
 async idleMaintenance(agent){
  const settings=this.settings,value=settings?.configFile.value;if(!settings?.index||!value.enabled||!value.automatic||!value.deferred||this.idleAbort||agent.status!=='idle'||agent.inbox.hasPending)return;
  const measurement=this.ctx.tokenMeter.measure(agent.session);if(measurement.totalTokens<Math.max(value.headroomTokens,4096))return;
  const config=agent.session.requestHeader()?.config;if(!config)return;
  const abort=new AbortController();this.idleAbort=abort;this.idleAgent=agent;
  try{await agent.runMaintenance(async nativeSignal=>{
   const signal=AbortSignal.any([nativeSignal,abort.signal]),info=await this.ctx.llm.resolveModelInfo(config.provider,config.model,signal);if(!info.context)return;
   const override=this.config.modelPolicies.find(policy=>policy.provider===config.provider&&policy.model===config.model)??{};
   const window=info.context.contextWindow,output=config.maxTokens??info.defaultMaxTokens??0,threshold=Math.min(window*Math.min(value.deferredRatio,override.thresholdRatio??this.config.thresholdRatio),window-output-(override.headroomTokens??this.config.headroomTokens));
   if(threshold<=0||measurement.totalTokens<threshold)return;
   const retain=override.retainTokens??(override.retainRatio!==undefined?Math.floor((window-output)*override.retainRatio):(this.config.retainTokens??Math.floor((window-output)*this.config.retainRatio)));
   const nodes=agent.session.surface.nodes,first=agent.session.deriveEventMessage(agent.session.eventAt(nodes[0]))?.role==='system'?1:0;let from=nodes.length,kept=0;
   for(let i=nodes.length-1;i>=first;i--){from=i;kept+=measurement.nodes[i].tokens;if(kept>=retain)break;}
   while(from>first&&(!toolPairingBalancedBefore(agent.session,nodes[from])||!toolPairingBalancedAfter(agent.session,nodes[from-1])))from--;
   if(from<=first)return;
   const system=first?agent.session.deriveEventMessage(agent.session.eventAt(nodes[0])):null,input={tools:agent.session.requestHeader()?.tools,messages:[...(system?[system]:[]),...nodes.slice(first,from).map(seq=>agent.session.deriveEventMessage(agent.session.eventAt(seq))).filter(Boolean)]};
   const {plan}=await this.prepare(input,agent,signal,value),warmId='warm:'+randomUUID();let count=0,ordinal=0;
   for(const group of plan.groups){if(count>=2)break;const payload=plan.groups.length===1?input:{...input,messages:[...(plan.system?[plan.system]:[]),...group.messages]},key=this.cacheKey(payload,agent);if(this.cached(key))continue;
    signal.throwIfAborted();const started=performance.now(),result=await this.completeSummary(payload,agent,signal,value,metadata=>settings.index.auxiliary(agent.session.id,warmId,ordinal++,'truncated',metadata));signal.throwIfAborted();
    settings.index.auxiliary(agent.session.id,warmId,ordinal++,'warm-leaf',{provider:result.provider,model:result.model,maxTokens:result.maxTokens,usage:result.usage??null,durationMs:Math.round(performance.now()-started),estimatedOutputTokens:this.ctx.tokenMeter.estimateMessage({role:'assistant',content:result.summary})});count++;this.remember(key,result,warmId);
   }
  });}finally{if(this.idleAbort===abort){this.idleAbort=null;this.idleAgent=null;}}
 }
 cacheKey(input,agent){return createHash('sha256').update(JSON.stringify([agent.session.id,agent.session.requestHeader()?.config??agent.options,this.config,input])).digest('hex');}
 cached(key){const row=this.warmed.get(key);if(!row)return null;if(Date.now()-row.at>1800000){this.warmed.delete(key);return null;}return row;}
 remember(key,result,source){this.warmed.set(key,{result,source,at:Date.now()});while(this.warmed.size>64)this.warmed.delete(this.warmed.keys().next().value);}
 completeSummary(input,agent,signal,value,onTruncated){return summarizeComplete(BasicCompactionEngine.prototype.summarize,this.ctx,this.config,input,agent,signal,{...value,onTruncated});}
 summarize(input,agent,signal){
  const settings=this.settings,value=settings?.configFile.value;
  if(!settings?.index||!value.enabled)return super.summarize(input,agent,signal);
  const abort=new AbortController();this.summaryAborts.add(abort);const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
  const operation=this.summarizeLossless(input,agent,combined,settings,value);
  settings.tasks.add(operation);
  return operation.finally(()=>{settings.tasks.delete(operation);this.summaryAborts.delete(abort);if(this.pendingConfig&&!this.summaryAborts.size){this.config=this.pendingConfig;this.pendingConfig=null;}});
 }
 async prepare(input,agent,signal,value){
  const routed=agent.session.requestHeader()?.config??agent.options,override=this.config.modelPolicies.find(policy=>policy.provider===routed.provider&&policy.model===routed.model)??{};
  const provider=(override.summarizationProvider??this.config.summarizationProvider)||routed.provider,model=(override.summarizationModel??this.config.summarizationModel)||routed.model;
  const info=await this.ctx.llm.resolveModelInfo(provider,model,signal),system=input.messages[0]?.role==='system'?input.messages[0]:null;
  const overhead=(system?this.ctx.tokenMeter.estimateMessage(system):0)+Math.ceil(JSON.stringify(input.tools??[]).length/3)+2000;
  const initial=override.maxTokens??this.config.maxTokens,window=info.context?.contextWindow;
  const reserve=value.summaryRetries?Math.max(initial,Math.min(value.summaryRetryMaxTokens,Math.floor(window/4))):initial;
  const {available}=summaryBudget(info,reserve,overhead);
  const plan=leafPlan(input,this.ctx.tokenMeter,Math.min(value.leafChunkTokens,available));
  if(plan.groups.length>256||plan.groups.some(group=>group.tokens>available))throw new Error('lcm-leaf-exceeds-summary-model-budget');
  return {plan,available};
 }
 async summarizeLossless(input,agent,signal,settings,value){
  const index=settings.index;index.sync(agent.session);const compactionId=index.active(agent.session.id);if(!compactionId)throw new Error('lcm-native-compaction-marker-missing');
  const {plan,available}=await this.prepare(input,agent,signal,value);
  const leaves=[];let ordinal=0;
  const run=async(payload,kind)=>{
   signal.throwIfAborted();const started=performance.now(),key=kind==='leaf'?this.cacheKey(payload,agent):null,cached=key?this.cached(key):null,result=cached?{...cached.result,usage:undefined,rawOutput:undefined,llmStreamCall:false}:await this.completeSummary(payload,agent,signal,value,metadata=>index.auxiliary(agent.session.id,compactionId,ordinal++,'truncated',metadata));
   signal.throwIfAborted();index.auxiliary(agent.session.id,compactionId,ordinal++,kind,{provider:result.provider,model:result.model,maxTokens:result.maxTokens,usage:result.usage??null,cachedFrom:cached?.source??null,estimatedOutputTokens:this.ctx.tokenMeter.estimateMessage({role:'assistant',content:result.summary}),durationMs:Math.round(performance.now()-started)});if(key&&!cached)this.remember(key,result,compactionId);return result;
  };
  if(plan.groups.length===1){const result=await run(input,'leaf');index.plan(agent.session.id,compactionId,{leaves:[{start:0,end:plan.groups[0].end,summary:summaryText(result)}]});return this.withRecallHint(result,value);}
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
  const result=layer[0].result;
  return this.withRecallHint(result,value);
 }
 withRecallHint(result,value){return value.promptAwareRecall?{...result,summary:[...result.summary,{type:'text',text:'需要精确原文时，可用 lcm_grep 检索当前会话，或 lcm_describe / lcm_expand 按摘要节点展开；超长工具原文可通过 DSH 提供的完整结果文件读取。'}]}:result;}
}
