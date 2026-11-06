import { execFile } from 'node:child_process'
import { createServer } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import { z } from 'zod'
import { NpmPackageVerifier } from '../service/update/verifier.js'
import { boundedRegistryFetch } from '../service/update/network.js'
import { artifactIntegrity, inspectRelease } from '../service/update/release.js'
import { atomicJson, boundedJson, noLinks } from '../service/update/journal.js'
import { readBootIdentity } from '../service/update/files.js'
import { idSchema, identitySchema, sameIdentity, type ReleaseIdentity } from '../service/update/protocol.js'
import { isElevated, configureCodex } from './codex-setup.js'
import { configureClaude } from './claude-setup.js'
import { configureWindowsCommand } from './windows-command.js'
import { loadConfig } from '../core/config.js'
import { defaultEndpoint } from '../ipc/endpoint.js'
import type { DesktopUpdateAdapter } from './update.js'

const checkpointSchema=z.strictObject({id:idSchema,target:identitySchema})
const desktopCheckpointSchema=z.strictObject({stageId:idSchema,target:identitySchema,backup:z.string().regex(/^u-chan-secrets-[A-Za-z0-9.+-]+\.tgz$/)})
export async function acquireDesktopLock(directory:string):Promise<(()=>Promise<void>)|null>{
  const name=process.platform==='win32'?'\\\\.\\pipe\\u-chan-update-'+createHash('sha256').update(directory.toLowerCase()).digest('hex'):join(directory,'update.sock')
  const server=createServer(socket=>socket.destroy())
  return new Promise((resolve,reject)=>{
    server.once('error',(error:NodeJS.ErrnoException)=>error.code==='EADDRINUSE'?resolve(null):reject(error))
    server.listen({path:name,exclusive:true},()=>resolve(()=>new Promise<void>((done,fail)=>server.close(error=>error?fail(error):done()))))
  })
}
export async function verifyDesktopFiles(program:string,tarball:Buffer):Promise<void>{
  for(const [relative,bytes] of inspectRelease(tarball).files){
    const path=join(program,relative);await noLinks(path)
    const stat=await lstat(path)
    if(!stat.isFile()||stat.size!==bytes.length||!(await readFile(path)).equals(bytes))throw new Error('desktop_artifact_mismatch')
  }
}
/** npm runs only as the desktop user. No caller artifact reaches the privileged service. */
export function desktopUpdateAdapter(env:NodeJS.ProcessEnv=process.env):DesktopUpdateAdapter{
  const state=join(env.APPDATA??join(homedir(),'AppData','Roaming'),'u-chan-secrets')
  let program='',stage='',artifact:Buffer|undefined,npmEntry=''
  async function npm(args:string[]):Promise<string>{
    if(await isElevated())throw new Error('normal_desktop_user_required')
    if(!npmEntry){
      for(const candidate of [join(dirname(process.execPath),'node_modules/npm/bin/npm-cli.js'),join(dirname(process.execPath),'../lib/node_modules/npm/bin/npm-cli.js')]){
        try{await noLinks(candidate);if((await lstat(candidate)).isFile()){npmEntry=candidate;break}}catch{}
      }
      if(!npmEntry)throw new Error('trusted_npm_unavailable')
    }
    return new Promise((resolve,reject)=>execFile(process.execPath,[npmEntry,...args],{env,windowsHide:true,timeout:120000,maxBuffer:1024*1024},(error,stdout)=>error?reject(new Error('desktop_npm_failed')):resolve(stdout.trim())))
  }
  async function installed():Promise<string>{
    if(!program){const root=await npm(['root','--global','--loglevel=error']);if(!isAbsolute(root)||/[\r\n]/.test(root))throw new Error('invalid_npm_root');program=join(root,'u-chan-secrets');await noLinks(program)}
    return program
  }
  return {
    identity:async()=>readBootIdentity(await installed()),
    acquire:async()=>{if(await isElevated())throw new Error('normal_desktop_user_required');await noLinks(state);await mkdir(state,{recursive:true,mode:0o700});return acquireDesktopLock(state)},
    checkpoint:async value=>{
      const path=join(state,'update-checkpoint.json')
      if(value){await atomicJson(path,checkpointSchema.parse(value));return value}
      try{return checkpointSchema.parse(await boundedJson(path))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error}
    },
    recover:async target=>{
      const saved=desktopCheckpointSchema.parse(await boundedJson(join(state,'desktop-update.json')))
      if(!sameIdentity(saved.target,target))throw new Error('desktop_recovery_target_mismatch')
      const backup=join(state,'#0 backup','update-'+saved.stageId,'before',saved.backup);await noLinks(backup)
      const stat=await lstat(backup);if(!stat.isFile()||!stat.size)throw new Error('desktop_recovery_backup_missing')
      const verified=await new NpmPackageVerifier({fetcher:boundedRegistryFetch}).verify(target.version)
      if(!verified.ok||!verified.tarball||artifactIntegrity(verified.tarball)!==target.integrity)throw new Error('desktop_recovery_verification_failed')
      await verifyDesktopFiles(await installed(),verified.tarball)
      await atomicJson(join(program,'release.json'),target)
      return readBootIdentity(program)
    },
    prepare:async target=>{
      const result=await new NpmPackageVerifier({fetcher:boundedRegistryFetch}).verify(target.version)
      if(!result.ok||!result.tarball||artifactIntegrity(result.tarball)!==target.integrity)throw new Error('desktop_release_verification_failed')
      const manifest=inspectRelease(result.tarball)
      if(manifest.version!==target.version)throw new Error('desktop_version_mismatch')
      artifact=result.tarball
      const stageId=randomUUID()
      stage=join(state,'#0 backup','update-'+stageId);await noLinks(stage);await mkdir(join(stage,'before'),{recursive:true,mode:0o700})
      const packed=JSON.parse(await npm(['pack',await installed(),'--ignore-scripts','--pack-destination',join(stage,'before'),'--json']))
      if(!Array.isArray(packed)||packed.length!==1||!/^u-chan-secrets-[A-Za-z0-9.+-]+\.tgz$/.test(packed[0]?.filename))throw new Error('desktop_backup_failed')
      const backup=join(stage,'before',packed[0].filename);await noLinks(backup);if(!(await lstat(backup)).isFile())throw new Error('desktop_backup_failed')
      await writeFile(join(stage,'target.tgz'),artifact,{flag:'wx',mode:0o600})
      await atomicJson(join(stage,'target.json'),target)
      await atomicJson(join(state,'desktop-update.json'),{stageId,target,backup:packed[0].filename})
    },
    install:async target=>{
      if(!artifact||!stage)throw new Error('desktop_not_prepared')
      const path=join(stage,'target.tgz');await noLinks(path)
      if((await lstat(path)).size>32*1024*1024)throw new Error('desktop_artifact_too_large')
      const bytes=await readFile(path)
      if(artifactIntegrity(bytes)!==target.integrity||!bytes.equals(artifact))throw new Error('desktop_artifact_changed')
      await npm(['install','--global','--ignore-scripts','--no-audit','--no-fund',path])
      await verifyDesktopFiles(await installed(),bytes)
      await atomicJson(join(program,'release.json'),target)
      const identity=await readBootIdentity(program);if(!sameIdentity(identity,target))throw new Error('desktop_identity_mismatch');return identity
    },
    repair:async()=>{
      if(await isElevated())return false
      const config=loadConfig(env,process.platform),common={apply:false,replaceExisting:false,browser:config.browser,endpoint:config.cdpEndpoint,ipcEndpoint:defaultEndpoint(env,process.platform),nodePath:process.execPath,entryPath:join(await installed(),'dist/index.js')}
      const claudeDir=env.CLAUDE_CONFIG_DIR??join(homedir(),'.claude')
      const handlers=[(apply:boolean)=>configureCodex({...common,apply,replaceExisting:apply,configDir:env.CODEX_HOME??join(homedir(),'.codex')}),(apply:boolean)=>configureClaude({...common,apply,replaceExisting:apply,configDir:claudeDir,configPath:env.CLAUDE_CONFIG_DIR?join(claudeDir,'.claude.json'):join(homedir(),'.claude.json')})]
      let ready=(await configureWindowsCommand(true,env.PATH??env.Path??'')).ready
      for(const configure of handlers){const before=await configure(false);if(before.state==='needs_update'){const repaired=await configure(true);ready=repaired.state==='ready'&&ready}else if(!['ready','missing'].includes(before.state))ready=false}
      return ready
    },
  }
}
