import { cp, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { noLinks, boundedJson } from './journal.js'
import { observedIdentitySchema, type ObservedIdentity } from './protocol.js'
import { nativeFiles, type ReleaseManifest } from './release.js'

export async function readBootIdentity(program: string): Promise<ObservedIdentity> {
  const pkg = await boundedJson(join(program,'package.json')) as {version?:unknown}
  let integrity: unknown = null
  try { const receipt = observedIdentitySchema.parse(await boundedJson(join(program,'release.json'))); if (receipt.version !== pkg.version || !receipt.integrity) throw new Error('invalid_release_receipt'); integrity = receipt.integrity }
  catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e }
  return observedIdentitySchema.parse({version:pkg.version,integrity})
}
export async function installedRelease(program: string): Promise<{ dependencies: Record<string,string>; native: Record<string,Buffer> }> {
  const pkg = await boundedJson(join(program,'package.json')) as {dependencies?:Record<string,string>}
  const native:Record<string,Buffer>={}
  for(const name of nativeFiles) { const path=join(program,'dist/platform/windows/assets',name);await noLinks(path);if((await lstat(path)).size>1024*1024)throw new Error('invalid_native_template');native[name]=await readFile(path) }
  return {dependencies:pkg.dependencies??{},native}
}
export async function writeRelease(directory:string, manifest:ReleaseManifest):Promise<void>{
  await noLinks(directory)
  await mkdir(directory,{mode:0o700})
  for(const [relative,bytes] of manifest.files){const path=join(directory,relative);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,bytes,{flag:'wx',mode:0o600})}
}
export async function copyPrivate(source:string,destination:string):Promise<void>{
  await noLinks(source);await noLinks(destination)
  await cp(source,destination,{recursive:true,filter:async path=>{if((await lstat(path)).isSymbolicLink())throw new Error('unsafe_update_path');return true}})
}
