import { z } from 'zod'
import type { Approver, AuditLog, AuditEvent, ToolResult, VaultStatus } from '../core/types.js'
import type { TokenField } from '../discord/policy.js'
import { abortable } from '../core/abort.js'
import { aliasSchema, githubProposalSchema, githubReadSchema, githubCreateSchema, type GithubApi, type GithubConnection, type GithubRead, type GithubCreate } from './policy.js'
import { GithubHttp, GithubHttpError } from './http.js'
import type { GithubStore } from './store.js'
interface Dependencies {
 platform:NodeJS.Platform;store:GithubStore;http:GithubHttp;approver:Approver;audit:Pick<AuditLog,'record'>
 vault:{status(signal?:AbortSignal):Promise<VaultStatus>;getToken(item:string,field:TokenField,signal?:AbortSignal):Promise<string>;authorizationEpoch():number}
 queue:<T>(work:()=>Promise<T>)=>Promise<T>
}
class Refused extends Error {}
const refuse=(message:string):never=>{throw new Refused(message)}
const number=z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
const repositorySchema=z.object({id:number,full_name:z.string().max(150),private:z.boolean(),default_branch:z.string().max(255),archived:z.boolean(),disabled:z.boolean()})
const branchResult=z.object({name:z.string().max(255),commit:z.object({sha:z.string().regex(/^[a-f0-9]{40,64}$/)})})
const issueSchema=z.object({id:number,number,title:z.string().max(1024),state:z.string().max(30),body:z.string().max(65536).nullable().optional(),pull_request:z.unknown().optional()})
const pullSchema=issueSchema.extend({draft:z.boolean(),base:z.object({sha:z.string(),repo:z.object({id:number})}),head:z.object({sha:z.string(),repo:z.object({id:number}).nullable()})})
const json=(value:unknown)=>JSON.stringify(value).replace(/[\p{Cf}\p{Zl}\p{Zp}]/gu,c=>'\\u'+c.charCodeAt(0).toString(16).padStart(4,'0'))
const ok=(value:unknown):ToolResult=>({ok:true,message:json(value)})
export class GithubService implements GithubApi {
 constructor(private readonly d:Dependencies){}
 private run(work:(secrets:string[])=>Promise<ToolResult>):Promise<ToolResult>{
  return this.d.queue(async()=>{
   if(this.d.platform!=='win32')return {ok:false,message:'GitHub broker requires Windows protected review'}
   const secrets:string[]=[]
   const scrub=(value:string)=>secrets.reduce((text,secret)=>[secret,encodeURIComponent(secret),Buffer.from(secret).toString('base64'),Buffer.from(secret).toString('base64url')].reduce((v,s)=>s?v.split(s).join('[REDACTED]'):v,text),value)
   try{
    const result=await work(secrets)
    try{result.message=json(JSON.parse(JSON.stringify(JSON.parse(result.message),(_key,value)=>typeof value==='string'?scrub(value):value)))}catch{result.message=scrub(result.message)}
    if(Buffer.byteLength(JSON.stringify({id:Number.MAX_SAFE_INTEGER,...result}))>60000)return {ok:false,message:'GitHub result exceeds response limit; request one item'}
    return result
   }catch(error){
    const message=error instanceof Refused||error instanceof GithubHttpError?error.message:'GitHub operation failed; check vault, policy, and service diagnostics'
    return {ok:false,message:json({error:scrub(message),...(error instanceof GithubHttpError?{outcome:error.outcome,retryAfter:error.retryAfter}:{})})}
   }
  }).catch(()=>({ok:false,message:'GitHub service unavailable'}))
 }
 private path(c:Pick<GithubConnection,'owner'|'repo'>){return '/repos/'+c.owner+'/'+c.repo}
 private async audit(action:AuditEvent['action'],c:Pick<GithubConnection,'alias'>,result:string){await this.d.audit.record({action,domain:'github:'+c.alias,result})}
 private async connection(alias:string){if(!aliasSchema.safeParse(alias).success)return refuse('invalid GitHub alias');return await this.d.store.get(alias)??refuse('GitHub connection not approved')}
 private async token(c:Pick<GithubConnection,'item'|'field'>,secrets:string[],signal:AbortSignal){
  if(await abortable(this.d.vault.status(signal),signal)!=='unlocked')return refuse('vault locked or unavailable; use request_unlock')
  const token=await abortable(this.d.vault.getToken(c.item,c.field,signal),signal);secrets.push(token);return token
 }
 private async repository(c:Pick<GithubConnection,'owner'|'repo'>&{repositoryId?:number},token:string,signal:AbortSignal){
  const repo=repositorySchema.parse(await this.d.http.request(token,'GET',this.path(c),undefined,signal))
  if(repo.full_name.toLowerCase()!==(c.owner+'/'+c.repo).toLowerCase()||(c.repositoryId!==undefined&&repo.id!==c.repositoryId))return refuse('repository identity changed; approve a new connection')
  return repo
 }
 githubRequestAllow(proposal:unknown):Promise<ToolResult>{
  const parsed=githubProposalSchema.safeParse(proposal);if(!parsed.success)return Promise.resolve({ok:false,message:'invalid GitHub connection policy'})
  return this.run(async secrets=>{
   const c=parsed.data,previous=await this.d.store.get(c.alias)
   const approved=await this.d.approver.ask('U-Chan Secrets - GitHub connection',[
    'Allow repository metadata, issue/PR text, and workflow-status reads? Every create requires separate protected approval.',
    'Connection: '+json(c.alias),'Repository: '+c.owner+'/'+c.repo,'Bitwarden item: '+json(c.item),'Token field: '+json(c.field),
    ...(previous?['Replaces existing connection: '+json(previous)]:[]),
    'Duration: until revoked. This does not grant file reads, pushes, merges, deletion, workflow execution, or arbitrary HTTP.',
   ])
   await this.audit('github_allow',c,approved?'connection approved':'connection denied')
   if(!approved)return {ok:false,message:'denied'}
   const signal=AbortSignal.timeout(30000),token=await this.token(c,secrets,signal),repo=await this.repository(c,token,signal)
   const entry={...c,repositoryId:repo.id};await this.d.store.upsert(entry)
   return ok({alias:c.alias,repositoryId:repo.id,repository:repo.full_name,approved:true})
  })
 }
 githubListAllowed(){return this.run(async()=>ok({connections:await this.d.store.list()}))}
 githubRevoke(alias:string){return this.run(async()=>{if(!aliasSchema.safeParse(alias).success)return refuse('invalid GitHub alias');await this.audit('github_revoke',{alias},'requested');return ok({alias,revoked:await this.d.store.remove(alias)})})}
 private issueView(c:GithubConnection,item:z.infer<typeof issueSchema>,body=false){return {number:item.number,title:item.title,state:item.state,url:`https://github.com/${c.owner}/${c.repo}/${item.pull_request?'pull':'issues'}/${item.number}`,...(body?{body:(item.body??'').slice(0,10000),bodyTruncated:(item.body?.length??0)>10000}:{})}}
 private route(c:GithubConnection,r:GithubRead):string{
  const base=this.path(c)
  switch(r.resource){
   case 'repository':return base
   case 'issues':return `${base}/issues?state=${r.state}&per_page=10&page=${r.page}`
   case 'issue':return `${base}/issues/${r.number}`
   case 'pull_requests':return `${base}/pulls?state=${r.state}&per_page=10&page=${r.page}`
   case 'pull_request':return `${base}/pulls/${r.number}`
   case 'workflow_runs':return `${base}/actions/runs?per_page=10&page=${r.page}`
  }
 }
 githubRead(alias:string,request:unknown){
  const parsed=githubReadSchema.safeParse(request);if(!parsed.success)return Promise.resolve({ok:false,message:'invalid GitHub read request'})
  return this.run(async secrets=>{
   const c=await this.connection(alias),signal=AbortSignal.timeout(30000),token=await this.token(c,secrets,signal),repo=await this.repository(c,token,signal),r=parsed.data
   let result:unknown
   if(r.resource==='repository')result=repo
   else{
    const raw=await this.d.http.request(token,'GET',this.route(c,r),undefined,signal)
    if(r.resource==='issue'||r.resource==='pull_request'){
     const item=issueSchema.parse(raw);if(item.number!==r.number)return refuse('GitHub item does not match request');result=this.issueView(c,{...item,...(r.resource==='pull_request'?{pull_request:true}:{})},true)
    }else if(r.resource==='workflow_runs'){
     const data=z.object({total_count:z.number().int().nonnegative(),workflow_runs:z.array(z.object({id:number,name:z.string().max(500).nullable(),status:z.string().max(50),conclusion:z.string().max(50).nullable(),head_sha:z.string().regex(/^[a-f0-9]{40,64}$/)})).max(10)}).parse(raw)
     result={...data,nextPage:r.page<999&&r.page*10<data.total_count?r.page+1:null}
    }else{
     const items=z.array(issueSchema).max(10).parse(raw)
     result={items:items.map(item=>this.issueView(c,{...item,...(r.resource==='pull_requests'?{pull_request:true}:{})})),page:r.page,nextPage:items.length===10&&r.page<999?r.page+1:null}
    }
   }
   await this.audit('github_read',c,'ok; '+r.resource)
   return ok({repositoryId:c.repositoryId,resource:r.resource,untrustedContent:true,data:result})
  })
 }
 private async branches(c:GithubConnection,op:GithubCreate,token:string,signal:AbortSignal){
  if(op.type!=='pull_request_create')return null
  const get=async(name:string)=>{const result=branchResult.parse(await this.d.http.request(token,'GET',this.path(c)+'/branches/'+encodeURIComponent(name),undefined,signal));if(result.name!==name)return refuse('branch identity mismatch');return result.commit.sha}
  return {base:await get(op.base),head:await get(op.head)}
 }
 githubCreate(alias:string,operation:unknown){
  const parsed=githubCreateSchema.safeParse(operation);if(!parsed.success)return Promise.resolve({ok:false,message:'invalid GitHub create operation'})
  return this.run(async secrets=>{
   const c=await this.connection(alias),op=parsed.data,preflight=AbortSignal.timeout(30000),token=await this.token(c,secrets,preflight),repo=await this.repository(c,token,preflight)
   if(repo.archived||repo.disabled)return refuse('repository is archived or disabled')
   const tips=await this.branches(c,op,token,preflight)
   const review=['Create exactly one GitHub item? This can notify repository participants.','Connection: '+json(c.alias),'Repository: '+c.owner+'/'+c.repo,'Repository ID: '+c.repositoryId,'Operation: '+json(op),...(tips?['Branch tips: '+json(tips),'The pull request will be a draft. This does not merge or push code.']:[])]
   if(Buffer.byteLength(JSON.stringify(review))>12000)return refuse('operation too large for complete protected review')
   if(!await this.d.approver.ask('U-Chan Secrets - GitHub create',review)){await this.audit('github_write',c,'denied');return {ok:false,message:'denied'}}
   const epoch=this.d.vault.authorizationEpoch(),signal=AbortSignal.timeout(30000),current=await this.connection(alias)
   if(json(current)!==json(c))return refuse('connection changed after approval')
   const freshToken=await this.token(c,secrets,signal),freshRepo=await this.repository(c,freshToken,signal)
   if(freshRepo.archived||freshRepo.disabled||json(await this.branches(c,op,freshToken,signal))!==json(tips))return refuse('repository or branches changed after approval; inspect and propose again')
   await this.audit('github_write',c,'approved; dispatching '+op.type)
   const body=op.type==='issue_create'?{title:op.title,body:op.body}:{title:op.title,body:op.body,head:op.head,base:op.base,draft:true}
   if(await abortable(this.d.vault.status(signal),signal)!=='unlocked'||this.d.vault.authorizationEpoch()!==epoch)return refuse('vault authorization changed; create was not sent')
   const raw=await this.d.http.request(freshToken,'POST',this.path(c)+(op.type==='issue_create'?'/issues':'/pulls'),body,signal)
   let created:z.infer<typeof issueSchema>
   try{
    created=issueSchema.parse(raw)
    if(created.title!==op.title||(created.body??'')!==op.body||(op.type==='issue_create'&&created.pull_request!==undefined))throw new Error()
    if(op.type==='pull_request_create'){
     const pull=pullSchema.parse(raw)
     if(pull.base.repo.id!==c.repositoryId||pull.head.repo?.id!==c.repositoryId||pull.base.sha!==tips?.base||pull.head.sha!==tips?.head||!pull.draft)throw new Error()
    }
   }catch{throw new GithubHttpError('GitHub item may have been created but verification failed; inspect before retrying','unknown')}
   const result=this.issueView(c,{...created,...(op.type==='pull_request_create'?{pull_request:true}:{})})
   try{await this.audit('github_write',c,'created '+op.type+' #'+created.number)}catch{return {ok:false,message:json({outcome:'executed_audit_failed',created:result,error:'creation executed; audit failed; inspect before retrying'})}}
   return ok({outcome:'created',created:result})
  })
 }
}
