import { describe, expect, it } from 'vitest'
import { runCoordinatedUpdate, trustedReinstallSteps } from '../src/client/update.js'
import { integrity } from './fixtures/update-release.js'
import type { CoordinatedUpdateApi, UpdateJob } from '../src/service/update/protocol.js'
const target={version:'2.1.0',integrity:integrity(Buffer.from('x'))},source={version:'2.0.0',integrity:null}
function fixture(serviceNew=true,desktopNew=true){
  const calls:string[]=[],job={id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',phase:'ready_to_apply',source,target,createdAt:1,updatedAt:1} as UpdateJob
  let now=0
  const client={capabilities:async()=>({ok:true,message:JSON.stringify({protocol:3,features:['coordinated_update'],release:['waiting_for_service','service_ready'].includes(job.phase)?target:serviceNew?source:target})}),planUpdate:async()=>({ok:true,message:JSON.stringify({service:serviceNew?source:target,target,decision:serviceNew?'update_required':'up_to_date',compatible:true,reason:null,platform:'win32',coordinator:1})}),beginUpdate:async()=>{calls.push('begin');return{ok:true,message:JSON.stringify(job)}},updateStatus:async()=>({ok:true,message:JSON.stringify(job)}),activateUpdate:async()=>{calls.push('activate');job.phase='waiting_for_service';return{ok:true,message:'accepted'}},confirmUpdateReady:async()=>{calls.push('confirm');job.phase='service_ready';return{ok:true,message:'confirmed'}}} as CoordinatedUpdateApi&{capabilities():Promise<{ok:boolean;message:string}>}
  const desktop={identity:async()=>desktopNew?source:target,prepare:async()=>{calls.push('prepare')},install:async()=>{calls.push('install');return target},acquire:async()=>{calls.push('lock');return async()=>{calls.push('release')}},repair:async()=>true}
  return{client,desktop,calls,deps:{client,desktop,progress:()=>{},now:()=>now,sleep:async()=>{now+=1000}}}
}
describe('coordinated update client',()=>{
  it('bootstrap failure names desktop version and steps',async()=>{
    const f=fixture();f.client.capabilities=async()=>({ok:true,message:JSON.stringify({protocol:3,features:[]})});f.desktop.identity=async()=>({...source,version:'5.1.2'})
    const r=await runCoordinatedUpdate({checkOnly:false},f.deps)
    expect(r.ok).toBe(false);expect(r.message.startsWith('coordinated updater bootstrap required')).toBe(true);expect(r.message).toContain(trustedReinstallSteps('5.1.2'))
  })
  it('bootstrap failure falls back to a placeholder when desktop identity is unreadable',async()=>{
    const f=fixture();f.client.capabilities=async()=>({ok:true,message:JSON.stringify({protocol:3,features:[]})});f.desktop.identity=async()=>{throw new Error('x')}
    const r=await runCoordinatedUpdate({checkOnly:false},f.deps)
    expect(r.message).toContain(trustedReinstallSteps('<version>'))
  })
  it('incompatible plan names target version and steps',async()=>{
    const f=fixture();f.client.planUpdate=async()=>({ok:true,message:JSON.stringify({service:source,target:{...target,version:'5.2.0'},decision:'update_required',compatible:false,reason:'native_helpers_changed',platform:'win32',coordinator:1})})
    const r=await runCoordinatedUpdate({checkOnly:false},f.deps)
    expect(r.ok).toBe(false);expect(r.message).toContain('native_helpers_changed');expect(r.message).toContain(trustedReinstallSteps('5.2.0'));expect(r.message).toContain('no components changed')
  })
  it('local_ahead service is never told to reinstall an older version',async()=>{
    const f=fixture();f.client.planUpdate=async()=>({ok:true,message:JSON.stringify({service:{...target,version:'2.2.0'},target,decision:'local_ahead',compatible:false,reason:'local_ahead',platform:'win32',coordinator:1})})
    const r=await runCoordinatedUpdate({checkOnly:false},f.deps)
    expect(r).toEqual({ok:false,message:'local_ahead; no components changed'});expect(r.message).not.toContain('Trusted reinstall');expect(f.calls).toEqual([])
  })
  it('check is read-only and desktop-only updates never dispatch a service restart',async()=>{
    const check=fixture();expect((await runCoordinatedUpdate({checkOnly:true},check.deps)).ok).toBe(true);expect(check.calls).toEqual([])
    const desktop=fixture(false);expect((await runCoordinatedUpdate({checkOnly:false},desktop.deps)).ok).toBe(true);expect(desktop.calls).toEqual(['lock','prepare','install','release'])
  })
  it('waits for observed target readiness before desktop installation',async()=>{
    const f=fixture();expect((await runCoordinatedUpdate({checkOnly:false},f.deps)).ok).toBe(true)
    expect(f.calls.indexOf('confirm')).toBeLessThan(f.calls.indexOf('install'))
  })
  it('reports partial desktop failure after service success and releases the user lock',async()=>{
    const f=fixture();f.desktop.install=async()=>{throw new Error('SECRET npm failure')}
    const result=await runCoordinatedUpdate({checkOnly:false},f.deps)
    expect(result.ok).toBe(false);expect(result.message).toContain('partial');expect(result.message).not.toContain('SECRET');expect(f.calls.at(-1)).toBe('release')
  })
  it('resumes a protected active transaction without creating another',async()=>{
    const f=fixture(),job={id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',phase:'service_ready',source,target,createdAt:1,updatedAt:1}
    f.client.planUpdate=async()=>({ok:true,message:JSON.stringify({service:target,target,decision:'up_to_date',compatible:true,reason:null,platform:'win32',coordinator:1,activeJob:job})})
    f.client.capabilities=async()=>({ok:true,message:JSON.stringify({protocol:3,features:['coordinated_update'],release:target})})
    const result=await runCoordinatedUpdate({checkOnly:false},f.deps)
    expect(result.ok).toBe(true);expect(f.calls).not.toContain('begin');expect(JSON.parse(result.message).vault).toBe('unknown')
  })
  it('refuses unknown desktop identity and target drift before installation',async()=>{
    const unknown=fixture();unknown.desktop.identity=async()=>({...target,integrity:null})
    expect((await runCoordinatedUpdate({checkOnly:false},unknown.deps)).ok).toBe(false);expect(unknown.calls).toEqual([])
    const drift=fixture();drift.client.beginUpdate=async()=>({ok:true,message:JSON.stringify({id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',phase:'ready_to_apply',source,target:{...target,version:'2.2.0'},createdAt:1,updatedAt:1})})
    expect((await runCoordinatedUpdate({checkOnly:false},drift.deps)).ok).toBe(false);expect(drift.calls).not.toContain('activate');expect(drift.calls).not.toContain('install')
  })
  it('recovers a completed npm installation only under the exclusive user lock',async()=>{
    const f=fixture(false),desktop={...f.desktop,recover:async()=>{f.calls.push('recover');return target},repair:async()=>{f.calls.push('repair');return true}}
    desktop.identity=async()=>({...target,integrity:null})
    const result=await runCoordinatedUpdate({checkOnly:false},{...f.deps,desktop})
    expect(result.ok).toBe(true);expect(f.calls).toEqual(['lock','recover','repair','release'])
    expect(JSON.parse(result.message)).toMatchObject({agentSessionRestartRequired:true,rollbackRetained:true})
    const check=await runCoordinatedUpdate({checkOnly:true},{...f.deps,desktop})
    expect(check.ok).toBe(true);expect(f.calls).toEqual(['lock','recover','repair','release'])
  })
})

describe('update messages',()=>{
  it('reinstall steps use npm.cmd in the elevated step',()=>{
    const steps=trustedReinstallSteps('5.2.1')
    expect(steps).toContain('npm.cmd ci; npm.cmd run build; node dist/cli.js install')
    expect(steps).not.toMatch(/(^|[\s;:])npm (ci|run)/)
  })
  it('unreachable service says so instead of transaction status',async()=>{
    const f=fixture();f.client.capabilities=async()=>({ok:false,message:'U-Chan service is not running — run u-chan install'})
    const r=await runCoordinatedUpdate({checkOnly:true},f.deps)
    expect(r).toEqual({ok:false,message:'U-Chan service is not running — run u-chan install'})
  })
})