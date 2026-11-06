import { z } from 'zod'
import { aliasSchema, tokenFieldSchema } from '../discord/policy.js'
import type { ToolResult } from '../core/types.js'
export { aliasSchema }
export const ownerSchema=z.string().regex(/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/).refine(v=>!/[\s\p{Cc}\p{Cf}]/u.test(v))
export const repoSchema=z.string().min(1).max(100).regex(/^[A-Za-z0-9_.-]+$/).refine(v=>v!=='.'&&v!=='..'&&!v.endsWith('.git')&&!/[\s\p{Cc}\p{Cf}]/u.test(v))
const item=z.string().trim().min(1).max(200).refine(v=>!v.startsWith('-')&&!/[\p{Cc}\p{Cf}]/u.test(v))
export const githubProposalSchema=z.strictObject({alias:aliasSchema,item,field:tokenFieldSchema,owner:ownerSchema,repo:repoSchema})
export const githubConnectionSchema=githubProposalSchema.extend({repositoryId:z.number().int().positive().max(Number.MAX_SAFE_INTEGER)})
export type GithubConnection=z.infer<typeof githubConnectionSchema>
const page=z.number().int().min(1).max(999).default(1),number=z.number().int().positive().max(Number.MAX_SAFE_INTEGER)
export const githubReadSchema=z.discriminatedUnion('resource',[
  z.strictObject({resource:z.literal('repository')}),
  z.strictObject({resource:z.literal('issues'),state:z.enum(['open','closed','all']).default('open'),page}),
  z.strictObject({resource:z.literal('issue'),number}),
  z.strictObject({resource:z.literal('pull_requests'),state:z.enum(['open','closed','all']).default('open'),page}),
  z.strictObject({resource:z.literal('pull_request'),number}),
  z.strictObject({resource:z.literal('workflow_runs'),page}),
])
export type GithubRead=z.infer<typeof githubReadSchema>
const text=(max:number)=>z.string().max(max).refine(v=>!/[\p{Cf}\p{Zl}\p{Zp}\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/u.test(v))
const title=text(200).refine(v=>!!v.trim()&&!/[\r\n\t]/.test(v))
export const branchSchema=z.string().min(1).max(200).regex(/^[A-Za-z0-9_][A-Za-z0-9_./-]*$/).refine(v=>!/[\s\p{Cc}\p{Cf}]/u.test(v)&&!v.includes('..')&&!v.includes('//')&&!v.endsWith('/')&&v.split('/').every(p=>p&&!p.startsWith('.')&&!p.endsWith('.')&&!p.endsWith('.lock')))
export const githubCreateSchema=z.discriminatedUnion('type',[
  z.strictObject({type:z.literal('issue_create'),title,body:text(6000).default('')}),
  z.strictObject({type:z.literal('pull_request_create'),title,body:text(6000).default(''),head:branchSchema,base:branchSchema}),
]).refine(v=>Buffer.byteLength(JSON.stringify(v))<=8192&&(!('head'in v)||v.head!==v.base))
export type GithubCreate=z.infer<typeof githubCreateSchema>
export interface GithubApi {
 githubRequestAllow(proposal:unknown):Promise<ToolResult>
 githubListAllowed():Promise<ToolResult>
 githubRead(alias:string,request:unknown):Promise<ToolResult>
 githubCreate(alias:string,operation:unknown):Promise<ToolResult>
 githubRevoke(alias:string):Promise<ToolResult>
}
