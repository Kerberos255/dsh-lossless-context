import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');
const same=(a,b)=>process.platform==='win32'?a.toLowerCase()===b.toLowerCase():a===b;
const fail=message=>{throw new Error(message);};
const MIB=1024*1024;

export function rotationInput(home,sessionId,eventSeq,settings) {
 let size=0;
 try {
  const root=path.join(home,'sessions');
  for(const folder of fs.readdirSync(root,{withFileTypes:true})){
   if(!folder.isDirectory())continue;
   const file=path.join(root,folder.name,sessionId,'session.v4.jsonl.zstd');
   const stat=fs.statSync(file,{throwIfNoEntry:false});
   if(stat?.isFile())size=Math.max(size,stat.size);
  }
 } catch(error){if(error.code!=='ENOENT')throw error;}
 return {bytes:size,events:eventSeq+1,exceeded:size>=settings.rotationFileMiB*MIB||eventSeq+1>=settings.rotationEventLimit};
}

/** No model output, identity claim or Session pointer can bypass these gates. */
export async function rotateWithVerifiedMemory({ctx,session,expectedSeq,settings,signal}){
 signal?.throwIfAborted();
 const core=ctx.get?.('channelCore'),dream=ctx.get?.('memoryDreaming');
 if(!core?.rotateTrustedDM||core.closed)fail('缺少可验证的渠道会话绑定接口');
 if(!dream?.memory||!dream.configFile?.value.enabled)fail('Dream/长期记忆插件未就绪');
 const conf=dream.configFile.value;
 if(!conf.ownerIdentityId?.trim())fail('请先在 Dream 中设置记忆主人身份');
 if(!conf.autoPromote)fail('请先启用 Dream 已核实候选的自动发布；否则可能丢失长期事实');
 const header=session.header,cwd=header?.cwd,preset=ctx.get?.('sessionProjections')?.stateOf(session,'agentPreset')??header?.agentPreset??'';
 if(!cwd||header.parentSession||preset!==conf.agentPreset)fail('会话与 Dream 工作区或预设不一致');
 if(conf.workspace?.trim()&&!same(fs.realpathSync(conf.workspace),fs.realpathSync(cwd)))fail('Dream 工作区不匹配');
 if(core.trustedMemorySession(session.id,conf.ownerIdentityId)!==true)fail('仅主人身份已核验的私聊会话允许自动轮转');
 const agent=ctx.get?.('agents')?.get(session.id);
 if(agent&&agent.status!=='idle')fail('旧会话未空闲');
 if(agent?.inbox?.hasPending?.())fail('仍有待处理消息');
 const query=ctx.get?.('sessionQuery');
 if(!query)fail('原生会话查询不可用');
 const observe=async()=>{
  const obs=await query.observeSession(session.id,{signal});
  try{return obs.events.at(-1)?.seq??-1;}
  finally{obs[Symbol.dispose]?.();}
 };
 if(await observe()!==expectedSeq)fail('整理前旧会话又收到事件');
 const result=await dream.memory.run(cwd,'dream',{signal,sourceSessionId:session.id,draftOnly:false});
 signal?.throwIfAborted();
 if(result?.state!=='completed'||result.draftOnly||result.empty||result.rejected>0||result.staged>result.promoted)fail('记忆整理未全部通过归档与发布验收，保留原会话');
 // A committed and hashed Dream artifact is required for every switch.
 const artifact=result.artifacts?.find(x=>x.path==='DREAMS.md');
 if(!artifact||!/^\b[a-f0-9]{64}\b$/i.test(artifact.hash))fail('没有可核验的 Dream 交接文件');
 const file=path.join(fs.realpathSync(cwd),'DREAMS.md'),stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.size>1048576||sha(fs.readFileSync(file))!==artifact.hash)fail('Dream 交接文件已改变，未切换会话');
 if(await observe()!==expectedSeq)fail('整理期间旧会话发生了变化，未切换会话');
 const next='session-'+sha(JSON.stringify(['dsh-auto-rotation-v1',session.id])).slice(0,32);
 const existing=(await query.listSessions(signal)).find(row=>row.header?.id===next);
 if(!existing)await core.controller.create({sessionId:next,cwd,agentPreset:preset},signal);
 signal?.throwIfAborted();
 return core.rotateTrustedDM({previous:session.id,next,ownerIdentityId:conf.ownerIdentityId,cwd,preset,expectedSeq,memoryRunId:result.id,artifactHash:artifact.hash,signal});
}

export function installAutoRotation(ctx,configFile,enabled=()=>true){
 const inflight=new Set(),errors=new Map(),lastEnd=new Map(),abort=new AbortController();
 const run=(session,seq)=>{
  if(inflight.has(session.id))return;
  const promise=(async()=>{
   const conf=configFile.value;
   if(!enabled()||!conf.enabled||conf.rotationMode!=='auto')return;
   const core=ctx.get?.('channelCore'),dream=ctx.get?.('memoryDreaming');
   // Never scan Desktop, group, untrusted or unconfigured sessions.
   if(!core?.store?.db?.prepare('SELECT 1 FROM bindings WHERE session_id=? LIMIT 1').get(session.id))return;
   if(!dream?.configFile?.value?.ownerIdentityId||!core.trustedMemorySession?.(session.id,dream.configFile.value.ownerIdentityId))return;
   if(!rotationInput(ctx.dshHomePath(),session.id,seq,conf).exceeded)return;
   try{await rotateWithVerifiedMemory({ctx,session,expectedSeq:seq,settings:conf,signal:abort.signal});errors.delete(session.id);}
   catch(error){if(!abort.signal.aborted){errors.set(session.id,error.message);if(errors.size>100)errors.delete(errors.keys().next().value);}}
  })().finally(()=>inflight.delete(session.id));
  inflight.add(session.id);
  promise.catch(()=>{});
 };
 const listener=(session,event)=>{
  if(event.type!=='turn/end'||!Number.isSafeInteger(event.seq))return;
  lastEnd.set(session.id,event.seq);
  // Turn/end may be recorded before the Agent reports idle.
  if(ctx.get?.('agents')?.get(session.id)?.status==='idle'){
   lastEnd.delete(session.id);run(session,event.seq);
  }
  if(lastEnd.size>2000)lastEnd.delete(lastEnd.keys().next().value);
 };
 ctx.on('session/event',listener,{global:true});
 ctx.on('agent/status',({agent,status})=>{
  if(status!=='idle'||!agent?.session)return;
  const seq=lastEnd.get(agent.session.id);
  if(seq===undefined)return;
  lastEnd.delete(agent.session.id);run(agent.session,seq);
 },{global:true});
 ctx.effect(()=>()=>{abort.abort();lastEnd.clear();});
 return {status(sessionId){return{busy:inflight.has(sessionId),reason:errors.get(sessionId)||''};},summary(){return{busy:inflight.size,latestError:[...errors.values()].at(-1)||''};},close(){abort.abort();}};
}
