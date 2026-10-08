/** Retry only incomplete summaries. The native summarizer still validates every finish. */
export async function summarizeComplete(nativeSummarize, ctx, native, input, agent, signal, options) {
 const latest=agent.session.requestHeader()?.config??agent.options;
 const override=native.modelPolicies.find(row=>row.provider===latest.provider&&row.model===latest.model)??{};
 const config={...native,...override,modelPolicies:[]};
 const provider=config.summarizationProvider||latest.provider,model=config.summarizationModel||latest.model;
 const info=await ctx.llm.resolveModelInfo(provider,model,signal);
 const estimate=input.messages.reduce((tokens,message)=>tokens+ctx.tokenMeter.estimateMessage(message),0)+Math.ceil(JSON.stringify(input.tools??[]).length/3)+2000;
 const capacity=info.context?.contextWindow;
 const limits=[Math.max(config.maxTokens,options.summaryRetryMaxTokens)];
 if(Number.isSafeInteger(capacity))limits.push(capacity-estimate-512);
 if(Number.isSafeInteger(info.context?.maxOutputTokens))limits.push(info.context.maxOutputTokens);
 const ceiling=Math.floor(Math.min(...limits));
 if(ceiling<128)throw Object.assign(new Error('剩余模型窗口不足以生成完整摘要，请缩小待压缩片段'),{code:'SUMMARY_BUDGET'});
 for(let attempt=0,maxTokens=Math.min(config.maxTokens,ceiling);;attempt++){
  signal?.throwIfAborted();let usage,finish;
  const llm={stream:async function*(request){for await(const chunk of ctx.llm.stream(request)){if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finish=chunk.reason?.kind;yield chunk;}}};
  try{
   const result=await nativeSummarize.call({ctx:{llm},config:{...config,maxTokens}},input,agent,signal);
   signal?.throwIfAborted();return result;
  }catch(error){
   signal?.throwIfAborted();
   if(error.code!=='MAX_TOKENS')throw error;
   options.onTruncated?.({provider,model,maxTokens,attempt:attempt+1,finish,usage:usage??null});
   const next=Math.min(ceiling,maxTokens*2);
   if(attempt>=options.summaryRetries||next<=maxTokens)throw error;
   maxTokens=next;
  }
 }
}
