import { expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { startIpcServer } from '../src/ipc/server.js'
import { IpcClient } from '../src/ipc/client.js'
import { UpdateGate } from '../src/service/update/gate.js'
it('exposes typed update status and blocks credential calls during maintenance',async()=>{
  const path=process.platform==='win32'?`\\\\.\\pipe\\ucs-up-${randomUUID()}`:join(tmpdir(),'up-'+randomUUID().slice(0,8)+'.sock')
  const gate=new UpdateGate();gate.tryPause()
  let called=0,after=false
  const server=await startIpcServer(path,{capabilities:async()=>({ok:true,message:JSON.stringify({protocol:3,features:['coordinated_update']})}),updateStatus:async()=>({ok:true,message:'safe status'}),activateUpdate:async()=>({ok:true,message:'accepted'}),unlock:async()=>{called++;return {ok:true,message:'unlocked'}}} as never,{admission:gate,afterResponse:async method=>{if(method==='activate_update')after=true}})
  try{
    const client=new IpcClient(path)
    expect(await client.updateStatus(randomUUID())).toEqual({ok:true,message:'safe status'})
    expect((await client.unlock()).ok).toBe(false);expect(called).toBe(0)
    expect((await client.activateUpdate(randomUUID())).ok).toBe(true)
    await new Promise(r=>setTimeout(r,10));expect(after).toBe(true)
  }finally{await new Promise<void>(r=>server.close(()=>r()))}
})
