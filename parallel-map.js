/** Bounded independent summaries, ordered output; settle all peers before native rollback. */
export async function mapBounded(items, limit, mapper, signal) {
 if (!Number.isSafeInteger(limit)||limit<1||limit>8) throw new RangeError('lcm-summary-concurrency-invalid');
 signal?.throwIfAborted();
 const results=new Array(items.length),abort=new AbortController();
 const combined=signal?AbortSignal.any([signal,abort.signal]):abort.signal;
 let cursor=0,firstError=null;
 const worker=async()=>{
  while(cursor<items.length&&!firstError&&!combined.aborted){
   const index=cursor++;
   try{results[index]=await mapper(items[index],index,combined);}
   catch(error){if(!firstError){firstError=error;abort.abort(error);}}
  }
 };
 await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));
 if(firstError)throw firstError;
 combined.throwIfAborted();
 return results;
}
