import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const MIB=1024*1024;
/** Read only: never rewrites/removes native sessions or changes active SessionBindings. */
export function rotationDecision({bytes=0,events=null},config){
  const maxBytes=config.rotationFileMiB*MIB, maxEvents=config.rotationEventLimit;
  const large=bytes>=maxBytes;
  const long=Number.isSafeInteger(events)&&events>=maxEvents;
  return {exceeded:large||long,fileExceeded:large,eventExceeded:long,
    hasEventCount:Number.isSafeInteger(events)};
}

function sessionFiles(home){
  const root=path.join(home,'sessions'),files=[];
  let workspaces=[];
  try { workspaces=readdirSync(root,{withFileTypes:true}); } catch(error) {
    if(error.code==='ENOENT')return files;throw error;
  }
  for(const workspace of workspaces){
    if(!workspace.isDirectory())continue;
    const scope=path.join(root,workspace.name);
    let sessions;
    try { sessions=readdirSync(scope,{withFileTypes:true}); } catch(error) {
      if(error.code==='ENOENT')continue;throw error;
    }
    for(const entry of sessions){
      if(!entry.isDirectory())continue;
      const source=path.join(scope,entry.name,'session.v4.jsonl.zstd');
      try {
        const stat=statSync(source,{throwIfNoEntry:false});
        if(stat?.isFile())files.push({sessionId:entry.name,bytes:stat.size});
      } catch(error) {if(error.code!=='ENOENT')throw error;}
    }
  }
  return files;
}

/** Estimates based on compressed file bytes + latest observed native event seq.
 * The persisted cursor can lag when indexing was disabled; the UI says so.
 */
export function inspectRotation(home,index,config,liveSeq=new Map()){
  if(config.rotationMode==='off')return {
    message:'长会话提醒已关闭；历史仍持续保留，不会自动清理。',
    rotationStatus:'已关闭',rotationSessionCount:0,rotationExceededCount:0
  };
  const cursors=new Map();
  if(index)for(const row of index.db.prepare('SELECT session_id,next_seq FROM lcm_cursor').all())
    cursors.set(row.session_id,row.next_seq);
  const files=sessionFiles(home);
  const rows=files.map(row=>{
    const events=liveSeq.get(row.sessionId)??cursors.get(row.sessionId)??null;
    return {...row,events,...rotationDecision({bytes:row.bytes,events},config)};
  });
  const exceeded=rows.filter(row=>row.exceeded);
  const largest=rows.reduce((v,row)=>Math.max(v,row.bytes),0);
  const mostEvents=rows.reduce((v,row)=>Math.max(v,row.events??0),0);
  const note=exceeded.length
    ? `有 ${exceeded.length} 个 Session 达到轮转提醒阈值。先完成记忆整理并确认交接，再在 DSH 创建新 Session；旧历史保留。`
    : '未发现达到阈值的会话。';
  return {message:note,rotationStatus:note,
    rotationSessionCount:rows.length,rotationExceededCount:exceeded.length,
    rotationLargestMiB:(largest/MIB).toFixed(2)+' MiB',
    rotationLargestEvents:mostEvents?String(mostEvents)+'（索引/本次运行记录）':'未获得事件数',
    rotationHandoff:'当前只提供轮转提醒；不自动重置 Session，也不自动转移记忆。请先执行 Dream/长期记忆整理并确认保存，再手动新建 Session。'
  };
}
