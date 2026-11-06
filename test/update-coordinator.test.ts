import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { UpdateCoordinator } from '../src/service/update/coordinator.js'
import { UpdateGate } from '../src/service/update/gate.js'
import { UpdateJournal } from '../src/service/update/journal.js'
import { release, integrity } from './fixtures/update-release.js'

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ucs-coordinate-'))), program = join(home,'program')
  const native = join(program,'dist/platform/windows/assets')
  await mkdir(native,{recursive:true}); await mkdir(join(program,'node_modules'))
  await mkdir(join(program,'dist/service/update'),{recursive:true});await writeFile(join(program,'dist/service/update/worker-main.js'),'old worker')
  await writeFile(join(program,'package.json'),JSON.stringify({name:'u-chan-secrets',version:'2.0.0',dependencies:{}}))
  for(const name of ['prompt-src.js','auth-src.js','service-src.js']) await writeFile(join(native,name),'native')
  const bytes=release(), target={version:'2.1.0',integrity:integrity(bytes)}, gate=new UpdateGate(), journal=new UpdateJournal(home)
  let launched=0
  const coordinator=new UpdateCoordinator({home,boot:{version:'2.0.0',integrity:null},platform:'win32',journal,gate,verifier:{checkLatest:async()=>({isNewer:true,latestVersion:target.version}),verify:async()=>({ok:true,targetVersion:target.version,tarball:bytes})},secure:async()=>{},verifyActive:async()=>{},launch:async()=>{launched++},audit:async()=>{}})
  return {home,coordinator,gate,journal,target,launched:()=>launched}
}
describe('update coordinator',()=>{
  it('refuses incompatible protected state before creating a transaction',async()=>{
    const f=await fixture();await writeFile(join(f.home,'schema.json'),'invalid')
    expect((await f.coordinator.planUpdate()).ok).toBe(false)
    expect((await f.coordinator.beginUpdate(f.target)).ok).toBe(false)
    expect(await f.journal.latest()).toBeNull()
  })
  it('plans without creating transaction state and rejects target drift',async()=>{
    const f=await fixture(), plan=await f.coordinator.planUpdate()
    expect(plan.ok).toBe(true);expect(JSON.parse(plan.message).compatible).toBe(true)
    expect(await f.journal.latest()).toBeNull()
    expect((await f.coordinator.beginUpdate({...f.target,integrity:integrity(Buffer.from('other'))})).ok).toBe(false)
    expect(await f.journal.latest()).toBeNull()
  })
  it('stages one job, pauses only when idle, and launches after the response hook',async()=>{
    const f=await fixture(), started=await f.coordinator.beginUpdate(f.target)
    const id=JSON.parse(started.message).id
    await f.coordinator.waitForStage()
    expect((await f.journal.read(id)).phase).toBe('ready_to_apply')
    const leave=f.gate.enter('unlock')!
    expect((await f.coordinator.activateUpdate(id)).ok).toBe(false);leave()
    expect((await f.coordinator.activateUpdate(id)).ok).toBe(true)
    expect(f.launched()).toBe(0)
    await f.coordinator.afterResponse('activate_update',id)
    expect(f.launched()).toBe(1)
    expect((await f.coordinator.updateStatus(id)).message).not.toContain('nonce')
    expect((await f.coordinator.confirmUpdateReady(id)).ok).toBe(false)
  })
  it('attaches duplicate requests and acknowledges only immutable target boot identity',async()=>{
    const f=await fixture(),first=await f.coordinator.beginUpdate(f.target),second=await f.coordinator.beginUpdate(f.target),id=JSON.parse(first.message).id
    expect(JSON.parse(second.message).id).toBe(id)
    await f.coordinator.waitForStage();await f.coordinator.activateUpdate(id);await f.coordinator.afterResponse('activate_update',id)
    await f.journal.transition(id,'waiting_for_service')
    expect((await f.coordinator.confirmUpdateReady(id)).ok).toBe(false)
    await f.journal.acknowledge(id,f.target,process.pid)
    expect((await f.journal.marker(id))?.boot).toEqual(f.target)
    const plan=JSON.parse((await f.coordinator.planUpdate()).message)
    expect(plan.activeJob.id).toBe(id);expect(plan.activeJob.nonce).toBeUndefined()
  })
})
