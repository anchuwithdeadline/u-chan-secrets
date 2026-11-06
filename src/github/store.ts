import { mkdir, readFile, writeFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { atomicJson, boundedJson, noLinks } from '../service/update/journal.js'
import { githubConnectionSchema, type GithubConnection } from './policy.js'
const entriesSchema=z.array(githubConnectionSchema).max(20).refine(v=>new Set(v.map(c=>c.alias)).size===v.length)
export class GithubStore {
 constructor(private readonly path:string,private readonly beforeWrite:()=>Promise<void>=async()=>{}){}
 async list():Promise<GithubConnection[]>{
  try{return entriesSchema.parse(await boundedJson(this.path))}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return [];throw new Error('invalid GitHub connection state')}
 }
 async get(alias:string){return (await this.list()).find(c=>c.alias===alias)}
 async upsert(connection:GithubConnection){const entry=githubConnectionSchema.parse(connection);await this.write([...(await this.list()).filter(c=>c.alias!==entry.alias),entry])}
 async remove(alias:string){const entries=await this.list(),next=entries.filter(c=>c.alias!==alias);if(next.length===entries.length)return false;await this.write(next);return true}
 private async write(entries:GithubConnection[]){entriesSchema.parse(entries);if(Buffer.byteLength(JSON.stringify(entries))>16384)throw new Error('GitHub connection state full');await this.beforeWrite();await atomicJson(this.path,entries)}
}
/** Preserve only this connector's policy, without traversing historical backups or vault contents. */
export async function backupGithubPolicy(home:string,secure:(path:string)=>Promise<void>):Promise<void>{
 const parent=join(home,'#0 backup');await noLinks(parent);await mkdir(parent,{recursive:true});await secure(parent)
 const backup=join(parent,'github-before-'+randomUUID());await mkdir(backup);await secure(backup)
 const source=join(home,'github-allowlist.json');await noLinks(source)
 try{const stat=await lstat(source);if(!stat.isFile()||stat.size>16384)throw new Error('invalid GitHub policy snapshot');await writeFile(join(backup,'github-allowlist.json'),await readFile(source),{flag:'wx',mode:0o600})}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error}
 await writeFile(join(backup,'complete'),'github policy snapshot',{flag:'wx',mode:0o600})
}
