import { fork } from 'node:child_process'
import { join } from 'node:path'
import { checkWindowsPermissions } from '../../platform/windows/doctor.js'
import { setAdminOnlyAcl } from '../../platform/windows/acl.js'
import { UpdateJournal } from './journal.js'
import type { UpdateJob } from './protocol.js'
import { terminal } from './protocol.js'

export const secureUpdateDirectory=(path:string)=>setAdminOnlyAcl(path,undefined,false)
export const verifyUpdateDirectory=async(path:string)=>await checkWindowsPermissions(path,false)==='pass'
export async function verifyUpdateActive(home:string,path?:string):Promise<void>{
  const checks=path?[checkWindowsPermissions(path)]:[checkWindowsPermissions(home,false),checkWindowsPermissions(join(home,'program')),checkWindowsPermissions(join(home,'bin'))]
  if((await Promise.all(checks)).some(value=>value!=='pass'))throw new Error('unsafe_update_permissions')
}
export function launchUpdateWorker(home:string,job:UpdateJob,exit:()=>void=()=>process.exit(0)):Promise<void>{
  return new Promise((resolve,reject)=>{
    const runtime=join(home,'updates',job.id,'runtime'),env:NodeJS.ProcessEnv={...process.env,U_CHAN_HOME:home}
    delete env.BW_SESSION
    const child=fork(join(runtime,'dist/service/update/worker-main.js'),[job.id],{execPath:join(home,'bin','node.exe'),cwd:runtime,env,detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']})
    let started=false
    const timer=setTimeout(()=>{if(!started){child.kill();reject(new Error('worker_start_failed'))}},30000)
    child.once('error',()=>{clearTimeout(timer);reject(new Error('worker_start_failed'))})
    child.once('exit',()=>{if(!started){clearTimeout(timer);reject(new Error('worker_start_failed'))}else void productionJournal(home).read(job.id).then(current=>{if(!terminal(current.phase))return productionJournal(home).transition(job.id,'recovery_required','worker_failed')}).catch(()=>{})})
    child.on('message',message=>{
      const m=message as {type?:unknown;id?:unknown;nonce?:unknown}
      if(m?.id!==job.id||m.nonce!==job.nonce)return
      if(m.type==='ready'&&!started){started=true;clearTimeout(timer);child.send({type:'start',id:job.id,nonce:job.nonce});child.unref();resolve()}
      if(m.type==='activated'&&started)exit()
    })
  })
}
export const productionJournal=(home:string)=>process.platform==='win32'
  ?new UpdateJournal(home,secureUpdateDirectory,verifyUpdateDirectory)
  :new UpdateJournal(home,async()=>{throw new Error('unsupported_update_platform')},async path=>(await import('../../platform/darwin/doctor.js')).checkDarwinPermissions(path).then(state=>state==='pass'))
