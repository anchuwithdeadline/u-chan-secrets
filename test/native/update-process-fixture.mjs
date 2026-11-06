// Disposable process-lifetime fixture. Never accesses SCM, installed U-Chan, or vault data.
import { fork } from 'node:child_process'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UpdateJournal } from '../../dist/service/update/journal.js'
import { runUpdateTransaction } from '../../dist/service/update/worker.js'
import { inspectRelease } from '../../dist/service/update/release.js'
const self=fileURLToPath(import.meta.url),sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))
const alive=pid=>{try{process.kill(pid,0);return true}catch{return false}}
const [mode,home,id,scenario]=process.argv.slice(2)
if(mode==='inspect'){
  const manifest=inspectRelease(await readFile(home))
  console.log(JSON.stringify({version:manifest.version,files:manifest.files.size}))
}else if(mode==='parent'){
  const journal=new UpdateJournal(home),job=await journal.create({version:'2.0.0',integrity:null},{version:'2.1.0',integrity:'sha512-'+Buffer.alloc(64).toString('base64')},process.pid)
  for(const phase of ['verifying','staging','ready_to_apply','switching'])await journal.transition(job.id,phase)
  await mkdir(join(home,'program'));await mkdir(join(journal.directory(job.id),'next'))
  await writeFile(join(home,'program/package.json'),'source');await writeFile(join(journal.directory(job.id),'next/package.json'),'target')
  await writeFile(join(home,'settings.json'),'preserve')
  const worker=fork(self,['worker',home,job.id,id],{detached:true,windowsHide:true,stdio:['ignore','ignore','ignore','ipc']})
  worker.on('message',message=>{if(message==='activated')process.exit(0)})
}else if(mode==='worker'){
  const journal=new UpdateJournal(home),job=await journal.read(id)
  let boot
  const result=await runUpdateTransaction(journal,id,{
    verify:async()=>{},
    handoff:async()=>{
      process.send('activated')
      const deadline=performance.now()+10000
      while(alive(job.parentPid)){if(performance.now()>deadline)throw new Error('parent_still_alive');await sleep(50)}
      if(process.connected)process.disconnect()
      await writeFile(join(home,'orphan-observed.json'),JSON.stringify({worker:process.pid,parent:job.parentPid,parentExited:!alive(job.parentPid)}))
    },
    stopForRollback:async()=>{boot?.kill()},startSource:async()=>{},
    waitReady:async kind=>{
      if(kind==='target'&&scenario==='rollback')return false
      boot=fork(self,['boot',home,id,kind],{windowsHide:true,stdio:'ignore'})
      const deadline=performance.now()+10000
      while(performance.now()<deadline){const marker=await journal.marker(id);if(marker?.kind===kind&&alive(marker.pid))return true;await sleep(50)}
      return false
    },
  })
  boot?.kill()
  await writeFile(join(home,'result.json'),JSON.stringify({phase:result.phase,program:await readFile(join(home,'program/package.json'),'utf8'),settings:await readFile(join(home,'settings.json'),'utf8')}))
}else if(mode==='boot'){
  const journal=new UpdateJournal(home),job=await journal.read(id)
  await journal.acknowledge(id,scenario==='target'?job.target:job.source,process.pid)
  setTimeout(()=>{},15000)
}else{
  if(process.platform!=='win32')throw new Error('Windows fixture required')
  const results=[]
  for(const scenario of ['success','rollback']){
    const directory=await mkdtemp(join(tmpdir(),'u-chan-native-update-'))
    const parent=fork(self,['parent',directory,scenario],{windowsHide:true,stdio:'ignore'})
    await new Promise((resolve,reject)=>{parent.once('error',reject);parent.once('exit',code=>code===0?resolve():reject(new Error('parent_failed')))})
    const deadline=performance.now()+20000
    let result
    while(performance.now()<deadline){try{result=JSON.parse(await readFile(join(directory,'result.json'),'utf8'));break}catch{await sleep(100)}}
    if(!result||result.phase!==(scenario==='success'?'service_ready':'rolled_back')||result.settings!=='preserve'||result.program!==(scenario==='success'?'target':'source'))throw new Error('native_transaction_failed')
    const orphan=JSON.parse(await readFile(join(directory,'orphan-observed.json'),'utf8'))
    if(!orphan.parentExited)throw new Error('parent_survived')
    // Check worker termination twice; retained temporary directories are recovery evidence.
    for(let i=0;i<2;i++){await sleep(200);if(alive(orphan.worker))throw new Error('worker_not_terminated')}
    results.push({scenario,...result,parentExited:true,workerTerminated:true,directory})
  }
  console.log(JSON.stringify({platform:process.platform,scope:'native processes and filesystem; excludes SCM, ACL and production IPC',results},null,2))
}
