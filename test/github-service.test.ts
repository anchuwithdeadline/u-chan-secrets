import { expect, it, vi } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { GithubService } from '../src/github/service.js'
import { GithubStore } from '../src/github/store.js'
import { GithubHttp } from '../src/github/http.js'
import { githubCreateSchema } from '../src/github/policy.js'
const connection={alias:'work',item:'GitHub credential',field:{kind:'password' as const},owner:'example',repo:'project',repositoryId:42}
const token='github_secret_1234567890'
async function fixture(approved=true){
 const dir=await mkdtemp(join(tmpdir(),'ucs-github-')),store=new GithubStore(join(dir,'connections.json'))
 if(approved)await store.upsert(connection)
 const repository={id:42,full_name:'example/project',private:true,default_branch:'main',archived:false,disabled:false}
 const vault={status:vi.fn(async()=>'unlocked' as 'unlocked'|'locked'),getToken:vi.fn(async()=>token),authorizationEpoch:vi.fn(()=>0)}
 const approver={ask:vi.fn(async(_title:string,_lines:string[])=>true)},audit={record:vi.fn(async(_e:unknown)=>{})}
 const fetcher=vi.fn(async(url:string,init:RequestInit)=>{
  const path=new URL(url).pathname
  if(path==='/repos/example/project')return Response.json(repository)
  if(path.includes('/branches/'))return Response.json({name:decodeURIComponent(path.split('/').at(-1)!),commit:{sha:'a'.repeat(40)}})
  if(init.method==='POST'){
   const body=JSON.parse(init.body as string)
   return Response.json({id:12,number:3,title:body.title,body:body.body,state:'open',...(path.endsWith('/pulls')?{draft:true,base:{sha:'a'.repeat(40),repo:{id:42}},head:{sha:'a'.repeat(40),repo:{id:42}}}:{})},{status:201})
  }
  if(path.endsWith('/issues'))return Response.json([{id:10,number:1,title:'untrusted text',state:'open'}])
  if(path.endsWith('/actions/runs'))return Response.json({total_count:0,workflow_runs:[]})
  return new Response('',{status:404})
 })
 let queue=Promise.resolve<unknown>(undefined)
 const service=new GithubService({platform:'win32',store,http:new GithubHttp(fetcher),vault,approver,audit,queue:work=>{const next=queue.then(work,work);queue=next.catch(()=>{});return next}})
 return{dir,store,repository,vault,approver,audit,fetcher,service,posts:()=>fetcher.mock.calls.filter(([,init])=>init.method==='POST')}
}
it('requires protected enrollment before any token lookup or GitHub request',async()=>{
 const f=await fixture(false);f.approver.ask.mockResolvedValue(false)
 const {repositoryId,...proposal}=connection
 expect((await f.service.githubRequestAllow(proposal)).ok).toBe(false)
 expect(f.vault.getToken).not.toHaveBeenCalled();expect(f.fetcher).not.toHaveBeenCalled()
 f.approver.ask.mockResolvedValue(true)
 expect((await f.service.githubRequestAllow(proposal)).ok).toBe(true)
 expect((await f.store.get('work'))?.repositoryId).toBe(42)
 expect(f.approver.ask.mock.calls[1][1].join(' ')).toContain('example/project')
})
it('refuses missing grants, locked vaults, and changed repository identities',async()=>{
 const f=await fixture(false)
 expect((await f.service.githubRead('work',{resource:'repository'})).ok).toBe(false);expect(f.fetcher).not.toHaveBeenCalled()
 await f.store.upsert(connection);f.vault.status.mockResolvedValue('locked')
 expect((await f.service.githubRead('work',{resource:'repository'})).ok).toBe(false);expect(f.fetcher).not.toHaveBeenCalled()
 f.vault.status.mockResolvedValue('unlocked');f.repository.id=99
 expect((await f.service.githubRead('work',{resource:'repository'})).message).toContain('identity changed')
})
it('projects bounded metadata and scrubs token values from remote content',async()=>{
 const f=await fixture();f.repository.default_branch=token
 const read=await f.service.githubRead('work',{resource:'repository'})
 expect(read.ok).toBe(true);expect(read.message).not.toContain(token);expect(read.message).toContain('REDACTED')
 expect((await f.service.githubRead('work',{resource:'issues'})).ok).toBe(true)
 expect((await f.service.githubRead('work',{resource:'workflow_runs'})).ok).toBe(true)
 expect(JSON.stringify(f.audit.record.mock.calls)).not.toContain(token)
})
it('creates one approved issue with exact reviewed content and no automatic replay',async()=>{
 const f=await fixture(),op={type:'issue_create',title:'Example',body:'line one\nline two'}
 const result=await f.service.githubCreate('work',op)
 expect(result.ok).toBe(true);expect(f.posts()).toHaveLength(1)
 expect(JSON.parse(f.posts()[0][1].body as string)).toEqual({title:op.title,body:op.body})
 expect(f.approver.ask.mock.calls[0][1].join(' ')).toContain(JSON.stringify(op))
 expect(JSON.parse(result.message).created.url).toBe('https://github.com/example/project/issues/3')
})
it('rechecks vault and repository after approval and refuses an audit failure before dispatch',async()=>{
 for(const change of ['lock','archive','audit'] as const){
  const f=await fixture();f.approver.ask.mockImplementation(async()=>{if(change==='lock')f.vault.status.mockResolvedValue('locked');if(change==='archive')f.repository.archived=true;return true})
  if(change==='audit')f.audit.record.mockRejectedValue(new Error('SECRET audit failure'))
  const result=await f.service.githubCreate('work',{type:'issue_create',title:'Example'})
  expect(result.ok).toBe(false);expect(f.posts()).toHaveLength(0);expect(result.message).not.toContain('SECRET')
 }
})
it('creates drafts only, checks branch tips, and rejects malformed write operations',async()=>{
 const f=await fixture(),op={type:'pull_request_create',title:'Draft',body:'Review',head:'feature/work',base:'main'}
 expect((await f.service.githubCreate('work',op)).ok).toBe(true)
 expect(JSON.parse(f.posts()[0][1].body as string).draft).toBe(true)
 for(const bad of [{...op,head:'../main'},{...op,head:'main'},{...op,draft:false},{type:'merge',number:1},{type:'issue_create',title:'x',url:'https://evil.test'}])expect(githubCreateSchema.safeParse(bad).success).toBe(false)
})
it('reports uncertain writes without retrying and preserves successful creation when audit fails',async()=>{
 const f=await fixture(),original=f.fetcher.getMockImplementation()!
 f.fetcher.mockImplementation(async(url,init)=>init.method==='POST'?new Response('',{status:503}):original(url,init))
 const result=await f.service.githubCreate('work',{type:'issue_create',title:'Example'})
 expect(result.ok).toBe(false);expect(result.message).toContain('unknown');expect(f.posts()).toHaveLength(1)
 const other=await fixture();other.audit.record.mockImplementation(async event=>{if((event as {result:string}).result.startsWith('created'))throw new Error('failure')})
 expect((await other.service.githubCreate('work',{type:'issue_create',title:'Example'})).message).toContain('executed_audit_failed')
})
it('refuses corrupt policy state and revokes without needing vault access',async()=>{
 const f=await fixture();f.vault.status.mockResolvedValue('locked')
 expect((await f.service.githubRevoke('work')).ok).toBe(true);expect(f.vault.getToken).not.toHaveBeenCalled()
 await writeFile(join(f.dir,'connections.json'),'[{"alias":"bad"}]')
 expect((await f.service.githubListAllowed()).ok).toBe(false)
})
it('refuses dispatch when a lock occurred during the final preflight, including lock/unlock cycles',async()=>{
 for(const lockAgain of [false,true]){
  const f=await fixture()
  f.audit.record.mockImplementation(async event=>{
   if((event as {result:string}).result.startsWith('approved; dispatching')){
    f.vault.authorizationEpoch.mockReturnValue(1)
    f.vault.status.mockResolvedValue(lockAgain?'unlocked':'locked')
   }
  })
  expect((await f.service.githubCreate('work',{type:'issue_create',title:'Example'})).ok).toBe(false)
  expect(f.posts()).toHaveLength(0)
 }
})
it('invalidates approval when a lock/unlock cycle occurs during the fresh token lookup',async()=>{
 const f=await fixture()
 f.vault.getToken.mockResolvedValueOnce(token).mockImplementationOnce(async()=>{f.vault.authorizationEpoch.mockReturnValue(1);return token})
 const result=await f.service.githubCreate('work',{type:'issue_create',title:'Example'})
 expect(result.ok).toBe(false);expect(f.posts()).toHaveLength(0)
})
it('refuses branch changes after review and reports mismatched create responses as uncertain',async()=>{
 const changed=await fixture(),original=changed.fetcher.getMockImplementation()!
 changed.approver.ask.mockImplementation(async()=>{changed.fetcher.mockImplementation(async(url,init)=>url.includes('/branches/')?Response.json({name:decodeURIComponent(new URL(url).pathname.split('/').at(-1)!),commit:{sha:'b'.repeat(40)}}):original(url,init));return true})
 expect((await changed.service.githubCreate('work',{type:'pull_request_create',title:'Draft',head:'feature',base:'main'})).ok).toBe(false)
 expect(changed.posts()).toHaveLength(0)
 const mismatch=await fixture(),fetch=mismatch.fetcher.getMockImplementation()!
 mismatch.fetcher.mockImplementation(async(url,init)=>init.method==='POST'?Response.json({id:12,number:3,title:'different text',body:'',state:'open'},{status:201}):fetch(url,init))
 const result=await mismatch.service.githubCreate('work',{type:'issue_create',title:'Approved text'})
 expect(result.ok).toBe(false);expect(result.message).toContain('unknown');expect(mismatch.posts()).toHaveLength(1)
})
