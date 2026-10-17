/** LCM capacity planning. Keep the host's native compaction transaction unchanged. */
export function adaptiveHeadroom(window,cap=65536){
 if(!Number.isSafeInteger(window)||window<=0)throw new Error('lcm-invalid-model-window');
 return Math.min(cap,Math.max(1024,Math.floor(window*0.10)));
}
/** Explicit per-model headroom is authoritative, even in automatic mode. */
export function pressureBudget({window,output=0,thresholdRatio=0.8,headroomTokens=65536,headroomMode='auto',override={}}){
 const safety=override.headroomTokens??(headroomMode==='auto'?adaptiveHeadroom(window,headroomTokens):headroomTokens);
 const threshold=Math.floor(Math.min(window*(override.thresholdRatio??thresholdRatio),window-output-safety));
 return {window,output,safety,threshold,ratio:override.thresholdRatio??thresholdRatio};
}
/** Start warming at least one whole leaf before the native pressure threshold. */
export function warmBudget({window,output=0,thresholdRatio,headroomTokens,headroomMode,override={},deferredRatio=0.75,leafChunkTokens=8000}){
 const pressure=pressureBudget({window,output,thresholdRatio,headroomTokens,headroomMode,override});
 const lead=Math.min(leafChunkTokens,Math.floor(Math.max(0,pressure.threshold)*0.2));
 return {...pressure,lead,trigger:Math.floor(Math.min(window*deferredRatio,pressure.threshold-lead))};
}
/** Never mutate a live shared engine config; a clone is bound to this model's
 * invocation so two concurrent agents with different window sizes cannot race.
 */
export function scopedNativeConfig(native,{window,headroomMode='auto',cap=65536,provider,model}){
 const override=native.modelPolicies.find(p=>p.provider===provider&&p.model===model);
 if(headroomMode!=='auto'||override?.headroomTokens!==undefined)return native;
 const headroomTokens=adaptiveHeadroom(window,cap);
 return {...native,headroomTokens};
}

/** Keep routine pressure for idle maintenance; interrupt an active task only near exhaustion. */
export function deferredPressureBudget(options) {
 const budget=pressureBudget(options),{window,output=0}=options;
 // Configured output can be the provider's very large absolute maximum,
 // not the amount normally generated in a step. Reserving all of it would
 // turn a 50% routine threshold into a spurious ~52% emergency threshold.
 // Use a bounded *forecast* for proactive interruption. Genuine provider
 // context overflows still follow the native recovery path.
 const emergencyOutputReserve=Math.min(Math.max(0,output),Math.max(16384,Math.floor(window*0.05)));
 const usable=window-emergencyOutputReserve-budget.safety;
 const emergency=Math.max(budget.threshold,Math.min(Math.floor(window*0.90),usable));
 return {...budget,emergencyOutputReserve,emergencyThreshold:Math.max(1,emergency)};
}

/** Same effective LCM tail policy for busy-turn pressure and idle maintenance. */
export function retainedTailTokens({window,output=0,config={},override={}}) {
 const budget=Math.max(0,window-output);
 const explicit=override.retainTokens!==undefined?override.retainTokens:
   override.retainRatio!==undefined?undefined:config.retainTokens;
 const result=explicit!==undefined?explicit:
   Math.floor(budget*(override.retainRatio??config.retainRatio??0.16));
 if(!Number.isSafeInteger(result)||result<0)throw new RangeError('invalid LCM retained-tail budget');
 return result;
}
