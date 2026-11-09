import { performance } from 'node:perf_hooks'
import type { ToolResult } from '../core/types.js'
import { observedIdentitySchema, planSchema, publicJobSchema, sameIdentity, planDecision, terminal, type CoordinatedUpdateApi, type ObservedIdentity, type ReleaseIdentity, type PublicUpdateJob } from '../service/update/protocol.js'

export interface DesktopUpdateAdapter {
  identity():Promise<ObservedIdentity>
  prepare(target:ReleaseIdentity):Promise<void>
  install(target:ReleaseIdentity):Promise<ObservedIdentity>
  recover?(target:ReleaseIdentity):Promise<ObservedIdentity>
  acquire():Promise<(()=>Promise<void>)|null>
  repair?():Promise<boolean>
  checkpoint?(value?:{id:string;target:ReleaseIdentity}):Promise<{id:string;target:ReleaseIdentity}|null>
}
interface Dependencies {
  client:Partial<CoordinatedUpdateApi>&{capabilities():Promise<ToolResult>;status?():Promise<ToolResult>}
  desktop:DesktopUpdateAdapter
  progress(phase:string,elapsedSeconds:number):void
  now?:()=>number
  sleep?:(ms:number)=>Promise<void>
}
export function trustedReinstallSteps(version:string):string{
  return [
    `Trusted reinstall required for ${version}.`,
    `1. Elevated terminal, in a reviewed u-chan-secrets ${version} checkout: npm ci; npm run build; node dist/cli.js install`,
    `2. Normal terminal: npm.cmd install --global u-chan-secrets@${version}; u-chan.cmd setup --apply; u-chan unlock`,
  ].join('\n')
}
export async function runCoordinatedUpdate(options:{checkOnly:boolean},d:Dependencies):Promise<ToolResult>{
  const now=d.now??(()=>performance.now()),sleep=d.sleep??(ms=>new Promise(r=>setTimeout(r,ms))),start=now()
  let release:(()=>Promise<void>)|null=null,serviceChanged=false,lastPhase='',lastPrinted=-1
  const progress=(phase:string)=>{const seconds=Math.floor((now()-start)/1000);if(phase!==lastPhase||seconds-lastPrinted>=5){d.progress(phase,seconds);lastPhase=phase;lastPrinted=seconds}}
  const failure=(message:string):ToolResult=>({ok:false,message})
  const capabilities=async()=>{const r=await d.client.capabilities();if(!r.ok)throw new Error();return JSON.parse(r.message) as {protocol?:number;features?:string[];release?:ObservedIdentity}}
  try{
    progress('checking')
    const initial=await capabilities()
    if(initial.protocol!==3||!initial.features?.includes('coordinated_update')||!d.client.planUpdate||!d.client.beginUpdate||!d.client.updateStatus||!d.client.activateUpdate||!d.client.confirmUpdateReady){
      let version='<version>'
      try{version=observedIdentitySchema.parse(await d.desktop.identity()).version}catch{}
      return failure('coordinated updater bootstrap required; install the matching trusted service first\n'+trustedReinstallSteps(version))
    }
    const response=await d.client.planUpdate()
    if(!response.ok)return response
    const plan=planSchema.parse(JSON.parse(response.message))
    let desktop=observedIdentitySchema.parse(await d.desktop.identity()),desktopDecision=planDecision(desktop,plan.target)
    if(options.checkOnly)return {ok:true,message:JSON.stringify({...plan,desktop,desktopDecision,readOnly:true})}
    if(plan.platform!=='win32')return failure('coordinated application requires Windows; no components changed')
    if(!plan.compatible)return failure((plan.reason??'incompatible update')+'; no components changed\n'+trustedReinstallSteps(plan.target.version))
    if(['local_ahead','identity_unknown'].includes(plan.decision)||desktopDecision==='local_ahead'||(desktopDecision==='identity_unknown'&&!d.desktop.recover))return failure((plan.reason??'local build identity is unknown or ahead')+'; no components changed')
    release=await d.desktop.acquire()
    if(!release)return failure('another desktop update is running; reconnect after it finishes')
    let desktopRecovered=false
    if(desktopDecision==='identity_unknown'){
      try{desktop=observedIdentitySchema.parse(await d.desktop.recover!(plan.target));desktopDecision=planDecision(desktop,plan.target)}catch{return failure('desktop identity unknown; restore the retained desktop package or perform a trusted desktop reinstall')}
      if(desktopDecision!=='up_to_date')return failure('desktop recovery did not establish target identity')
      desktopRecovered=true
    }
    let job:PublicUpdateJob|undefined=plan.activeJob??undefined
    const checkpoint=await d.desktop.checkpoint?.()
    if(!job&&checkpoint&&sameIdentity(checkpoint.target,plan.target)){
      const r=await d.client.updateStatus(checkpoint.id)
      if(r.ok){const saved=publicJobSchema.parse(JSON.parse(r.message));if(sameIdentity(saved.target,plan.target)&&saved.phase!=='failed')job=saved}
    }
    const desktopNeeded=desktopDecision==='update_required'
    if(desktopNeeded){progress('preparing_desktop');await d.desktop.prepare(plan.target)}
    if(!job&&plan.decision==='update_required'){
      progress('preparing_service')
      const result=await d.client.beginUpdate(plan.target)
      if(!result.ok)return result
      job=publicJobSchema.parse(JSON.parse(result.message))
      await d.desktop.checkpoint?.({id:job.id,target:plan.target})
    }
    if(job){
      await d.desktop.checkpoint?.({id:job.id,target:plan.target})
      while(now()-start<15*60*1000){
        if(!sameIdentity(job.target,plan.target))return failure('update transaction target changed; no further work dispatched')
        progress(job.phase)
        if(job.phase==='service_ready'){serviceChanged=true;break}
        if(terminal(job.phase))return failure('service update '+job.phase+'; retained recovery program and transaction '+job.id)
        if(job.phase==='ready_to_apply'){
          const r=await d.client.activateUpdate(job.id)
          if(!r.ok)return r
        }
        if(job.phase==='waiting_for_service'||job.phase==='rolling_back'){
          try{const cap=await capabilities(),expected=job.phase==='rolling_back'?job.source:job.target;if(cap.release&&sameIdentity(cap.release,expected))await d.client.confirmUpdateReady(job.id)}catch{}
        }
        await sleep(1000)
        try{const r=await d.client.updateStatus(job.id);if(r.ok)job=publicJobSchema.parse(JSON.parse(r.message))}catch{}
      }
      if(job.phase!=='service_ready')return failure('update still in progress; run u-chan update to reconnect to transaction '+job.id)
    }
    let finalDesktop=desktop
    if(desktopNeeded){progress('updating_desktop');try{finalDesktop=await d.desktop.install(plan.target)}catch{return failure('partial update: service verified; desktop installation failed. Run u-chan update to resume; desktop rollback package retained')}}
    const cap=await capabilities()
    if(!cap.release||!sameIdentity(cap.release,plan.target)||!sameIdentity(finalDesktop,plan.target))return failure('partial update: component identities do not match the verified target; retry update or inspect retained recovery copies')
    let registrationsReady=true
    if((desktopNeeded||desktopRecovered)&&d.desktop.repair)registrationsReady=await d.desktop.repair().catch(()=>false)
    progress('complete')
    let vault='unknown'
    try{const state=await d.client.status?.();const match=state?.message.match(/\bvault: (unlocked|locked|unauthenticated|unavailable)\b/);if(match)vault=match[1]}catch{}
    return {ok:true,message:JSON.stringify({status:'complete',desktop:finalDesktop,service:cap.release,serviceTransactionObserved:serviceChanged,vault,agentSessionRestartRequired:desktopNeeded||desktopRecovered,manualSetupRequired:!registrationsReady,rollbackRetained:serviceChanged||desktopNeeded||desktopRecovered})}
  }catch{return failure(serviceChanged?'partial update; service ready, finish desktop verification before claiming completion':'update check or preparation failed; inspect transaction status before retrying')}
  finally{await release?.().catch(()=>{})}
}
