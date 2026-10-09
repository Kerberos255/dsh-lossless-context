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
