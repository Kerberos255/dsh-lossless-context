export const summaryText=result=>(result.summary??[]).filter(block=>block.type==='text').map(block=>block.text).join('\n');
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
