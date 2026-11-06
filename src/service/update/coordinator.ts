import { mkdir, writeFile, readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import type { PackageVerifier, ToolResult } from '../../core/types.js'
import { UpdateJournal, atomicJson } from './journal.js'
import { UpdateGate } from './gate.js'
import { assertCompatibleState } from '../state.js'
import { artifactIntegrity, compatibleRelease, inspectRelease } from './release.js'
import { installedRelease, copyPrivate, writeRelease } from './files.js'
import { identitySchema, planDecision, publicJob, sameIdentity, terminal, type CoordinatedUpdateApi, type ObservedIdentity, type ReleaseIdentity, type UpdateJob, type UpdatePlan } from './protocol.js'

interface Dependencies {
  home:string; boot:ObservedIdentity; platform:NodeJS.Platform; verifier:PackageVerifier; journal:UpdateJournal; gate:UpdateGate
  secure(path:string):Promise<void>
  verifyActive(path?:string):Promise<void>
  launch(job:UpdateJob):Promise<void>
  audit(result:string):Promise<void>
}
const answer=(value:unknown):ToolResult=>({ok:true,message:JSON.stringify(value)})
const failure=(code:string):ToolResult=>({ok:false,message:code})
export class UpdateCoordinator implements CoordinatedUpdateApi {
  private staging:Promise<void>=Promise.resolve()
  private beginChain:Promise<unknown>=Promise.resolve()
  private pending:string|undefined
  constructor(private readonly d:Dependencies){}
  private async check():Promise<UpdatePlan>{
    const active=await this.d.journal.latest()
    if(active&&(!terminal(active.phase)||active.phase==='recovery_required'))return {service:this.d.boot,target:active.target,decision:planDecision(this.d.boot,active.target),compatible:active.phase!=='recovery_required',reason:active.phase==='recovery_required'?'recovery_required':null,platform:this.d.platform==='win32'?'win32':'unsupported',coordinator:1,activeJob:publicJob(active)}
    const latest=await this.d.verifier.checkLatest(this.d.boot.version)
    const verified=await this.d.verifier.verify(latest.latestVersion)
    if(!verified.ok||!verified.tarball)throw new Error('update_verification_failed')
    const target=identitySchema.parse({version:latest.latestVersion,integrity:artifactIntegrity(verified.tarball)})
    const decision=planDecision(this.d.boot,target)
    let reason:string|null=null
    if(this.d.platform!=='win32')reason='unsupported_platform'
    else if(decision==='update_required'){
      await this.d.verifyActive()
      await assertCompatibleState(this.d.home,Number(target.version.split('.')[0]))
      const manifest=inspectRelease(verified.tarball)
      if(manifest.version!==target.version)throw new Error('update_target_mismatch')
      reason=compatibleRelease(manifest,await installedRelease(join(this.d.home,'program')),process.versions.node)
    } else if(decision!=='up_to_date')reason=decision
    return {service:this.d.boot,target,decision,compatible:reason===null,reason,platform:this.d.platform==='win32'?'win32':'unsupported',coordinator:1}
  }
  async planUpdate():Promise<ToolResult>{try{return answer(await this.check())}catch{return failure('update_check_failed; no components changed')}}
  async beginUpdate(target:ReleaseIdentity):Promise<ToolResult>{
    const work=async()=>{
      try{
        if(this.d.platform!=='win32')return failure('coordinated updates require Windows')
        identitySchema.parse(target)
        const existing=await this.d.journal.latest()
        if(existing?.phase==='recovery_required')return failure('recovery_required; restore the retained program before starting another update')
        if(existing&&!terminal(existing.phase))return sameIdentity(existing.target,target)?answer(publicJob(existing)):failure('update_busy')
        const plan=await this.check()
        if(!sameIdentity(plan.target,target))return failure('update_target_changed; run update --check again')
        if(!plan.compatible||plan.decision!=='update_required')return failure(plan.reason??plan.decision)
        const job=await this.d.journal.create(this.d.boot,target,process.pid)
        this.staging=this.stage(job).catch(async()=>{await this.d.journal.transition(job.id,'failed','staging_failed').catch(()=>{})})
        return answer(publicJob(job))
      }catch{return failure('update_prepare_failed; active installation unchanged')}
    }
    const result=this.beginChain.then(work,work);this.beginChain=result.catch(()=>{});return result
  }
  private async stage(job:UpdateJob):Promise<void>{
    await this.d.journal.transition(job.id,'verifying')
    const verified=await this.d.verifier.verify(job.target.version)
    if(!verified.ok||!verified.tarball||artifactIntegrity(verified.tarball)!==job.target.integrity)throw new Error('verification_failed')
    const manifest=inspectRelease(verified.tarball)
    if(manifest.version!==job.target.version)throw new Error('target_mismatch')
    await this.d.verifyActive()
    await assertCompatibleState(this.d.home,Number(job.target.version.split('.')[0]))
    const program=join(this.d.home,'program')
    if(compatibleRelease(manifest,await installedRelease(program),process.versions.node))throw new Error('incompatible')
    await this.d.journal.transition(job.id,'staging')
    const dir=this.d.journal.directory(job.id),next=join(dir,'next'),runtime=join(dir,'runtime')
    await writeFile(join(dir,'release.tgz'),verified.tarball,{flag:'wx',mode:0o600})
    await writeRelease(next,manifest)
    await copyPrivate(join(program,'node_modules'),join(next,'node_modules'))
    await atomicJson(join(next,'release.json'),job.target)
    await mkdir(runtime,{mode:0o700});await this.d.secure(runtime)
    await copyPrivate(program,runtime)
    if(!(await lstat(join(runtime,'dist/service/update/worker-main.js'))).isFile())throw new Error('worker_bootstrap_missing')
    await this.d.verifyActive(next);await this.d.verifyActive(runtime)
    await this.d.audit('staged '+job.id)
    await this.d.journal.transition(job.id,'ready_to_apply')
  }
  async waitForStage():Promise<void>{await this.staging}
  async updateStatus(id:string):Promise<ToolResult>{try{await this.refreshGate();return answer(publicJob(await this.d.journal.read(id)))}catch{return failure('update_status_unavailable')}}
  async activateUpdate(id:string):Promise<ToolResult>{
    try{
      const job=await this.d.journal.read(id)
      if(job.phase!=='ready_to_apply')return answer(publicJob(job))
      if(this.pending===id)return answer(publicJob(job))
      if(!this.d.gate.tryPause())return failure('update_busy; finish active work before retrying')
      try{await this.d.audit('activate '+id)}catch{this.d.gate.resume();return failure('update_audit_failed; no switch dispatched')}
      this.pending=id
      return answer(publicJob(job))
    }catch{return failure('update_activation_failed')}
  }
  async afterResponse(method:string,id:string):Promise<void>{
    if(method!=='activate_update'||this.pending!==id)return
    this.pending=undefined
    try{const job=await this.d.journal.transition(id,'switching');await this.d.launch(job)}
    catch{await this.d.journal.transition(id,'failed','worker_failed').catch(()=>{});this.d.gate.resume()}
  }
  async confirmUpdateReady(id:string):Promise<ToolResult>{try{await this.d.journal.acknowledge(id,this.d.boot,process.pid);return answer({id,confirmed:true})}catch{return failure('update_readiness_identity_mismatch')}}
  async refreshGate():Promise<void>{
    const job=await this.d.journal.latest()
    if(!job)return
    if(job.parentPid!==process.pid&&['checking','verifying','staging','ready_to_apply'].includes(job.phase)){await this.d.journal.transition(job.id,'failed','interrupted');this.d.gate.resume();return}
    if(['switching','waiting_for_service','rolling_back','recovery_required'].includes(job.phase))this.d.gate.blocked=true
    else if(['service_ready','rolled_back','failed'].includes(job.phase))this.d.gate.resume()
  }
}
