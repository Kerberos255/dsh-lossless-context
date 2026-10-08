import { defineConfig } from './plugin-settings/remote-config.js';
const integer=(v,min,max)=>Number.isSafeInteger(v)&&v>=min&&v<=max;
const ratio=v=>Number.isFinite(v)&&v>=0.1&&v<=0.95;
const policyKeys=new Set(['provider','model','thresholdRatio','headroomTokens','retainRatio','retainTokens','summarizationProvider','summarizationModel','maxTokens','compactionRetries','maxOverflowRetries']);
export function policies(text){
 const value=JSON.parse(text);if(!Array.isArray(value)||value.length>100)throw new Error('model-policies-invalid');
 const seen=new Set();
 for(const p of value){if(!p||typeof p!=='object'||Array.isArray(p)||typeof p.provider!=='string'||typeof p.model!=='string'||!p.provider.trim()||!p.model.trim()||Object.keys(p).some(key=>!policyKeys.has(key)))throw new Error('model-policy-invalid');
  const key=p.provider+'\0'+p.model;if(seen.has(key))throw new Error('model-policy-duplicate');seen.add(key);
  for(const [key,val]of Object.entries(p)){
   if(['provider','model','summarizationProvider','summarizationModel'].includes(key)){if(typeof val!=='string'||val.length>256)throw new Error('model-policy-string');}
   else if(key.endsWith('Ratio')){if(!Number.isFinite(val)||val<=0||val>=1)throw new Error('model-policy-ratio');}
   else if(!integer(val,key==='maxTokens'?1:0,1048576))throw new Error('model-policy-integer');
  }
  if(p.retainRatio!==undefined&&p.retainTokens!==undefined)throw new Error('model-policy-retention');
  if((p.summarizationProvider===undefined)!==(p.summarizationModel===undefined)||!!p.summarizationProvider?.trim()!==!!p.summarizationModel?.trim())throw new Error('model-policy-summary-pair');
 }
 return value;
}
const defaults={enabled:true,automatic:true,thresholdRatio:0.8,headroomTokens:65536,retainRatio:0.16,retainTokens:0,leafChunkTokens:8000,condenseFanout:8,summaryMaxTokens:8192,summaryRetryMaxTokens:32768,summaryRetries:2,summaryModel:{provider:'',model:''},modelPoliciesJson:'[]',deferred:true,deferredRatio:0.7,recall:true,promptAwareRecall:true,maxRecallChars:16000,maxIndexedChars:32768,rotationMode:'auto',rotationFileMiB:20,rotationEventLimit:10000};
export const schema=defineConfig(defaults,{
 thresholdRatio:ratio,headroomTokens:v=>integer(v,0,1048576),retainRatio:(v,c)=>Number.isFinite(v)&&v>0&&v<c.thresholdRatio,retainTokens:v=>integer(v,0,1048576),leafChunkTokens:v=>integer(v,512,131072),condenseFanout:v=>integer(v,2,16),summaryMaxTokens:v=>integer(v,128,65536),summaryRetryMaxTokens:v=>integer(v,128,65536),summaryRetries:v=>integer(v,0,3),
 summaryModel:v=>v!==null&&!Array.isArray(v)&&Object.keys(v).length===2&&Object.hasOwn(v,'provider')&&Object.hasOwn(v,'model')&&typeof v.provider==='string'&&typeof v.model==='string'&&v.provider.length<=256&&v.model.length<=256&&!!v.provider.trim()===!!v.model.trim(),modelPoliciesJson:(v,c)=>{try{for(const p of policies(v))if(p.retainTokens===undefined&&(p.retainRatio!==undefined||!c.retainTokens)&&(p.retainRatio??c.retainRatio)>=(p.thresholdRatio??c.thresholdRatio))return false;return true;}catch{return false;}},
 // The runtime caps deferred work at the effective compaction threshold.
 // Keeping this independent lets users lower thresholdRatio in one save.
 deferredRatio:ratio,maxRecallChars:v=>integer(v,1000,65536),maxIndexedChars:v=>integer(v,4096,131072),
 rotationMode:v=>['off','auto'].includes(v),rotationFileMiB:v=>integer(v,1,2048),rotationEventLimit:v=>integer(v,100,1000000),
});
export function nativeConfig(value){return Object.freeze({thresholdRatio:value.thresholdRatio,headroomTokens:value.headroomTokens,...value.retainTokens>0?{retainTokens:value.retainTokens}:{retainRatio:value.retainRatio},summarizationProvider:value.summaryModel.provider.trim(),summarizationModel:value.summaryModel.model.trim(),maxTokens:value.summaryMaxTokens,compactionRetries:1,maxOverflowRetries:1,modelPolicies:policies(value.modelPoliciesJson),auto:true});}
