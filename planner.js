import { createHash } from 'node:crypto';

export const summaryText=result=>(result.summary??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
// Summaries reach the model as a marked envelope rather than bare prose: the
// attributes let it tell a compacted segment from live text and ask for the exact
// source through lcm_recall. Unknown metadata is omitted, never invented.
export const fileIdFor=text=>'file_'+createHash('sha1').update(text).digest('hex').slice(0,12);
export const fileReference=({id,chars})=>`[大文件已外置 ${id}：${chars} 字符。需要原文时用 lcm_recall(action='expand', id='${id}')，或 action='describe', id='${id}' 查看说明]`;
/** Replace oversized text blocks with a reference so summaries stay focused.
 *  Ids are content-addressed, so the warm pass and the commit agree byte for byte. */
export const externalizeLargeBlocks=(messages,{thresholdChars}={})=>{
 if(!(thresholdChars>0))return {messages,files:[]};
 const files=[];
 const next=(messages??[]).map(message=>{
  const content=message?.content;
  if(!Array.isArray(content))return message;
  let changed=false;
  const replaced=content.map(block=>{
   if(block?.type!=='text'||typeof block.text!=='string'||block.text.length<=thresholdChars)return block;
   const id=fileIdFor(block.text),chars=block.text.length;
   if(!files.some(file=>file.id===id))files.push({id,chars,text:block.text});
   changed=true;
   return {...block,text:fileReference({id,chars})};
  });
  return changed?{...message,content:replaced}:message;
 });
 return {messages:next,files};
};
export const summaryEnvelope=({text,id,kind,depth,sources,descendants}={})=>{
 const attrs=[['id',id],['kind',kind],['depth',depth],['sources',sources],['descendants',descendants]]
  .filter(([,value])=>value!==undefined&&value!==null&&value!=='')
  .map(([name,value])=>name+'="'+String(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/"/g,'&quot;')+'"').join(' ');
 return '<summary'+(attrs?' '+attrs:'')+'>\n<content>\n'+String(text??'')+'\n</content>\n</summary>';
};
export function leafPlan(input,meter,budget){
 const system=input.messages[0]?.role==='system'?input.messages[0]:null,body=system?input.messages.slice(1):input.messages;
 const groups=[],open=new Set();let messages=[],tokens=0,start=0;
 for(let index=0;index<body.length;index++){
  const message=body[index],cost=meter.estimateMessage(message);
  // A leaf must not exceed the model's real input budget simply because the
  // next message crosses a boundary. Never split an open tool call/result pair.
  if(messages.length&&!open.size&&tokens+cost>budget){groups.push({messages,tokens,start,end:index});messages=[];tokens=0;start=index;}
  messages.push(message);tokens+=cost;
  if(message.role==='assistant')for(const block of message.content??[])if(block.type==='tool-call')open.add(block.id);
  if(message.role==='tool')open.delete(message.toolCallId);
  if(!open.size&&tokens>=budget){groups.push({messages,tokens,start,end:index+1});messages=[];tokens=0;start=index+1;}
 }
 if(open.size)throw new Error('lcm-unbalanced-tool-pair');
 if(messages.length)groups.push({messages,tokens,start,end:body.length});
 return {system,groups};
}
export function summaryBudget(info,maxTokens,overhead){
 const window=info.context?.contextWindow;
 if(!Number.isSafeInteger(window)||window<=0)throw new Error('lcm-summary-model-context-missing');
 const available=window-maxTokens-Math.min(4096,Math.ceil(window*0.1))-overhead;
 if(available<512)throw new Error('lcm-summary-model-budget-too-small');return {window,available};
}
