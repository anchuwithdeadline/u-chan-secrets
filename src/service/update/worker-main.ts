import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { defaultProgramData } from '../../platform/windows/install.js'
import { ServiceManager } from '../../platform/windows/service-manager.js'
import { productionJournal, verifyUpdateActive, secureUpdateDirectory } from './native.js'
import { idSchema, sameIdentity } from './protocol.js'
import { artifactIntegrity, inspectRelease } from './release.js'
import { noLinks } from './journal.js'
import { runUpdateTransaction } from './worker.js'
import { assertCompatibleState } from '../state.js'

const sleep=(ms:number)=>new Promise<void>(resolve=>setTimeout(resolve,ms))
const alive=(pid:number)=>{try{process.kill(pid,0);return true}catch{return false}}
async function main():Promise<void>{
  if(process.platform!=='win32'||!process.send)throw new Error('unsupported_worker')
  const home=process.env.U_CHAN_HOME??defaultProgramData(),id=idSchema.parse(process.argv[2]),journal=productionJournal(home),job=await journal.read(id)
  if(job.parentPid!==process.ppid||job.phase!=='switching')throw new Error('invalid_worker_parent')
  delete process.env.BW_SESSION
  process.send({type:'ready',id,nonce:job.nonce})
  await new Promise<void>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('handoff_timeout')),30000)
    process.on('message',message=>{const m=message as {type?:string;id?:string;nonce?:string};if(m?.type==='start'&&m.id===id&&m.nonce===job.nonce){clearTimeout(timer);resolve()}})
  })
  const sm=new ServiceManager()
  const waitStatus=async(status:'running'|'stopped')=>{const end=performance.now()+30000;while(await sm.status('u-chan-secrets')!==status){if(performance.now()>end)throw new Error('service_timeout');await sleep(200)}}
  await runUpdateTransaction(journal,id,{
    verify:async()=>{
      await verifyUpdateActive(home)
      await assertCompatibleState(home,Number(job.target.version.split('.')[0]))
      const dir=journal.directory(id),archive=join(dir,'release.tgz');await noLinks(archive)
      if((await lstat(archive)).size>32*1024*1024)throw new Error('invalid_release')
      const bytes=await readFile(archive)
      if(artifactIntegrity(bytes)!==job.target.integrity)throw new Error('invalid_release')
      const release=inspectRelease(bytes)
      for(const [path,expected] of release.files){const p=join(dir,'next',path);await noLinks(p);if(!(await readFile(p)).equals(expected))throw new Error('staged_release_changed')}
      await verifyUpdateActive(home,join(dir,'next'))
      const parent=join(home,'#0 backup');await noLinks(parent)
      try{await lstat(parent)}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const fs=await import('node:fs/promises');await fs.mkdir(parent,{mode:0o700});await secureUpdateDirectory(parent)}
      if(await import('../../platform/windows/doctor.js').then(m=>m.checkWindowsPermissions(parent,false))!=='pass')throw new Error('unsafe_backup_parent')
    },
    handoff:async()=>{
      process.send?.({type:'activated',id,nonce:job.nonce})
      const end=performance.now()+30000
      while(alive(job.parentPid)){if(performance.now()>end)throw new Error('parent_exit_timeout');await sleep(200)}
      if(process.connected)process.disconnect?.()
    },
    stopForRollback:async()=>{if(!alive(job.parentPid)){await sm.stop('u-chan-secrets');await waitStatus('stopped')}},
    startSource:async()=>{if(!alive(job.parentPid)){await sm.start('u-chan-secrets');await waitStatus('running')}},
    waitReady:async kind=>{
      const end=performance.now()+90000,expected=kind==='target'?job.target:job.source
      let stable=0,lastPid=0
      while(performance.now()<end){
        const m=await journal.marker(id)
        if(m&&m.id===id&&m.nonce===job.nonce&&m.kind===kind&&sameIdentity(m.boot,expected)&&alive(m.pid)){stable=m.pid===lastPid?stable+1:1;lastPid=m.pid;if(stable>=2)return true}else{stable=0;lastPid=0}
        await sleep(500)
      }
      return false
    },
  })
}
main().catch(()=>{process.exitCode=1}).finally(()=>{if(process.connected)process.disconnect?.()})
