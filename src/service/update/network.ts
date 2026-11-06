import { abortable } from '../../core/abort.js'
/** Bound every registry request; credentials are never part of this transport. */
export const boundedRegistryFetch: typeof fetch = async (input, init) => {
  const signal = AbortSignal.timeout(30000)
  const response = await abortable(fetch(input,{...init,signal,redirect:'error'}),signal)
  if(Number(response.headers.get('content-length'))>32*1024*1024){await response.body?.cancel();throw new Error('registry_response_too_large')}
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[]
  let size=0
  try{
    if(reader)for(;;){const result=await abortable(reader.read(),signal);if(result.done)break;size+=result.value.length;if(size>32*1024*1024)throw new Error('registry_response_too_large');chunks.push(result.value)}
    return new Response(response.status===204?null:Buffer.concat(chunks),{status:response.status,statusText:response.statusText,headers:response.headers})
  }finally{await reader?.cancel().catch(()=>{})}
}
