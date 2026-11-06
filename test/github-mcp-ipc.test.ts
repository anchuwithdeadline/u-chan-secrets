import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../src/mcp/server.js'
import { startIpcServer } from '../src/ipc/server.js'
import { IpcClient } from '../src/ipc/client.js'
import { UpdateGate } from '../src/service/update/gate.js'
import { runGithubCli } from '../src/client/github.js'
import net from 'node:net'
import { FrameReader, encode } from '../src/ipc/protocol.js'
const endpoint=()=>process.platform==='win32'?`\\\\.\\pipe\\ucs-ext-${randomUUID()}`:join(tmpdir(),'ext-'+randomUUID().slice(0,8)+'.sock')
it('retains uncertainty if a service disconnects or sends an oversized response after create dispatch',async()=>{
 for(const malformed of [false,true]){
  const path=endpoint(),server=net.createServer(socket=>{
   const reader=new FrameReader()
   socket.on('data',chunk=>{for(const frame of reader.push(Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk))){
    const request=frame as {id:number;method:string}
    if(request.method==='capabilities')socket.write(encode({id:request.id,ok:true,message:JSON.stringify({protocol:3,features:['github_broker']})}))
    else if(malformed)socket.end('x'.repeat(65537))
    else socket.destroy()
   }})
  })
  await new Promise<void>(resolve=>server.listen(path,()=>resolve()))
  try{const result=await new IpcClient(path).githubCreate('work',{type:'issue_create',title:'Example'});expect(result.ok).toBe(false);expect(result.message).toContain('outcome unknown');expect(result.message).toContain('inspect before retrying')}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
 }
})
it('capability-gates new methods and blocks them during update maintenance',async()=>{
 const path=endpoint(),requestUnlock=vi.fn(async()=>({ok:true,message:'unlocked'})),githubRead=vi.fn(async()=>({ok:true,message:'metadata'}))
 let features:string[]=[],authorize=true
 const gate=new UpdateGate(),server=await startIpcServer(path,{capabilities:async()=>({ok:true,message:JSON.stringify({protocol:3,features})}),requestUnlock,githubRead} as never,{admission:gate,authorize:async()=>authorize})
 try{
  const client=new IpcClient(path)
  expect((await client.requestUnlock()).code).toBe('unsupported_service');expect(requestUnlock).not.toHaveBeenCalled()
  features=['agent_unlock','github_broker']
  expect((await client.requestUnlock()).ok).toBe(true)
  expect(await client.githubRead('work',{resource:'repository'})).toEqual({ok:true,message:'metadata'})
  expect((await client.githubRead('work',{resource:'file',path:'/token'})).ok).toBe(false)
  gate.tryPause();expect((await client.requestUnlock()).ok).toBe(false);expect(requestUnlock).toHaveBeenCalledTimes(1)
  expect((await client.githubRead('work',{resource:'repository'})).ok).toBe(false);expect(githubRead).toHaveBeenCalledTimes(1)
  gate.resume();authorize=false;expect((await client.requestUnlock()).ok).toBe(false);expect(requestUnlock).toHaveBeenCalledTimes(1)
 }finally{await new Promise<void>(resolve=>server.close(()=>resolve()))}
})
it('exposes safe MCP inputs without accepting password or arbitrary URL fields',async()=>{
 const core={login:async()=>({ok:true,message:''}),requestAllow:async()=>({ok:true,message:''}),revoke:async()=>({ok:true,message:''}),listAllowed:async()=>({ok:true,message:''}),status:async()=>({ok:true,message:''})}
 const requestUnlock=vi.fn(async()=>({ok:true,message:'unlocked'})),githubCreate=vi.fn(async()=>({ok:true,message:'created'}))
 const [ct,st]=InMemoryTransport.createLinkedPair(),server=createMcpServer(core,'test',undefined,{requestUnlock,githubCreate})
 await server.connect(st);const client=new Client({name:'test',version:'1'});await client.connect(ct)
 try{
  expect((await client.listTools()).tools.map(t=>t.name)).toContain('request_unlock')
  expect((await client.callTool({name:'request_unlock',arguments:{password:'must not reach service'}})).isError).toBe(true)
  expect(requestUnlock).not.toHaveBeenCalled()
  expect((await client.callTool({name:'request_unlock',arguments:{}})).isError).toBe(false)
  expect((await client.callTool({name:'github_create',arguments:{alias:'work',operation:{type:'issue_create',title:'Example',url:'https://evil.test'}}})).isError).toBe(true)
  expect(githubCreate).not.toHaveBeenCalled()
  expect((await client.callTool({name:'github_create',arguments:{alias:'work',operation:{type:'issue_create',title:'Example'}}})).isError).toBe(false)
 }finally{await client.close();await server.close()}
})
it('CLI rejects invalid JSON and dispatches typed operations',async()=>{
 const githubRead=vi.fn(async()=>({ok:true,message:'metadata'})),githubCreate=vi.fn(async()=>({ok:true,message:'created'}))
 expect((await runGithubCli(['test','work'],{githubRead},async()=>'' )).ok).toBe(true)
 expect(githubRead).toHaveBeenCalledWith('work',{resource:'repository'})
 expect((await runGithubCli(['create','work','operation.json'],{githubCreate},async()=>JSON.stringify({type:'issue_create',title:'Example'}))).ok).toBe(true)
 expect((await runGithubCli(['create','work','operation.json'],{githubCreate},async()=>'not json')).ok).toBe(false)
 expect(githubCreate).toHaveBeenCalledTimes(1)
})
