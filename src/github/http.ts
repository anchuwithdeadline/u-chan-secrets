import { abortable } from '../core/abort.js'
import { ownerSchema, repoSchema, branchSchema } from './policy.js'
export class GithubHttpError extends Error {
 constructor(message:string,readonly outcome:'failed'|'unknown',readonly retryAfter?:number){super(message)}
}
function validRoute(method:string,path:string):boolean{
 const [pathname,query,...extra]=path.split('?'),parts=pathname.split('/')
 if(extra.length||parts[0]!==''||parts[1]!=='repos'||!ownerSchema.safeParse(parts[2]).success||!repoSchema.safeParse(parts[3]).success)return false
 const tail=parts.slice(4).join('/')
 if(method==='POST')return query===undefined&&['issues','pulls'].includes(tail)
 if(query!==undefined&&!/^(?:state=(?:open|closed|all)&)?per_page=10&page=[1-9][0-9]{0,2}$/.test(query))return false
 if(['issues','pulls','actions/runs'].includes(tail))return query!==undefined
 if(query!==undefined)return false
 if(!tail)return true
 if(/^(issues|pulls)\/[1-9][0-9]{0,15}$/.test(tail))return true
 if(parts[4]==='branches'&&parts.length===6){try{return branchSchema.safeParse(decodeURIComponent(parts[5])).success}catch{return false}}
 return false
}
export class GithubHttp {
 private blockedUntil=0
 constructor(private readonly fetcher:(url:string,init:RequestInit)=>Promise<Response>=fetch){}
 async request(token:string,method:'GET'|'POST',path:string,body:unknown,signal:AbortSignal):Promise<unknown>{
  if(!validRoute(method,path))throw new GithubHttpError('invalid GitHub route','failed')
  signal.throwIfAborted()
  if(performance.now()<this.blockedUntil)throw new GithubHttpError('GitHub rate limited; retry later','failed',Math.ceil((this.blockedUntil-performance.now())/1000))
  const write=method==='POST'
  let response:Response
  try{response=await abortable(this.fetcher('https://api.github.com'+path,{method,redirect:'error',signal,headers:{Authorization:'Bearer '+token,Accept:'application/vnd.github+json','Content-Type':'application/json','User-Agent':'U-Chan-Secrets','X-GitHub-Api-Version':'2026-03-10'},...(body===undefined?{}:{body:JSON.stringify(body)})}),signal)}
  catch{throw new GithubHttpError(write?'GitHub write outcome unknown; inspect before retrying':'GitHub request failed',write?'unknown':'failed')}
  const retry=Number(response.headers.get('retry-after')),reset=Number(response.headers.get('x-ratelimit-reset'))
  if(response.status===429||(response.status===403&&(retry>0||response.headers.get('x-ratelimit-remaining')==='0'))){
   const seconds=Math.min(3600,Math.max(1,Number.isFinite(retry)&&retry>0?retry:response.headers.get('x-ratelimit-remaining')==='0'&&Number.isFinite(reset)&&reset>0?reset-Date.now()/1000:60))
   this.blockedUntil=performance.now()+seconds*1000;await response.body?.cancel().catch(()=>{})
   throw new GithubHttpError('GitHub rate limited; retry later','failed',Math.ceil(seconds))
  }
  if(!response.ok){await response.body?.cancel().catch(()=>{});throw new GithubHttpError(write&&response.status>=500?'GitHub write outcome unknown; inspect before retrying':`GitHub request rejected (HTTP ${response.status})`,write&&response.status>=500?'unknown':'failed')}
  const reader=response.body?.getReader(),chunks:Uint8Array[]=[];let size=0
  try{
   if(!reader||Number(response.headers.get('content-length'))>1024*1024)throw new Error()
   for(;;){const part=await abortable(reader.read(),signal);if(part.done)break;size+=part.value.length;if(size>1024*1024)throw new Error();chunks.push(part.value)}
   return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  }catch{throw new GithubHttpError(write?'GitHub write outcome unknown; inspect before retrying':'GitHub response unavailable or too large',write?'unknown':'failed')}
  finally{await reader?.cancel().catch(()=>{})}
 }
}
