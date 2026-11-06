import type { ToolResult } from '../core/types.js'
import { aliasSchema, githubProposalSchema, githubReadSchema, githubCreateSchema, type GithubApi } from '../github/policy.js'
export const GITHUB_USAGE='usage: u-chan github allow <connection.json> | list | test <alias> | read <alias> <request.json> | create <alias> <operation.json> | revoke <alias>'
export async function runGithubCli(args:string[],client:Partial<GithubApi>,read:(path:string)=>Promise<string>):Promise<ToolResult>{
 const [command,alias,file]=args,invalid={ok:false,message:GITHUB_USAGE}
 try{
  if(command==='list'&&args.length===1)return await client.githubListAllowed?.()??invalid
  if(command==='revoke'&&args.length===2&&aliasSchema.safeParse(alias).success)return await client.githubRevoke?.(alias)??invalid
  if(command==='test'&&args.length===2&&aliasSchema.safeParse(alias).success)return await client.githubRead?.(alias,{resource:'repository'})??invalid
  if((command==='allow'&&args.length===2)||(['read','create'].includes(command)&&args.length===3&&aliasSchema.safeParse(alias).success)){
   const raw=await read(command==='allow'?alias:file);if(Buffer.byteLength(raw)>16384)return {ok:false,message:'GitHub input file is too large'}
   const data:unknown=JSON.parse(raw)
   if(command==='allow')return githubProposalSchema.safeParse(data).success?await client.githubRequestAllow?.(data)??invalid:invalid
   if(command==='read')return githubReadSchema.safeParse(data).success?await client.githubRead?.(alias,data)??invalid:invalid
   return githubCreateSchema.safeParse(data).success?await client.githubCreate?.(alias,data)??invalid:invalid
  }
  return invalid
 }catch{return {ok:false,message:'GitHub command failed; check JSON input and service availability'}}
}
