import { z } from 'zod'
import { semverGt } from './verifier.js'

export const versionSchema = z.string().regex(/^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})$/)
export const integritySchema = z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/)
export const identitySchema = z.strictObject({ version: versionSchema, integrity: integritySchema })
export const observedIdentitySchema = z.strictObject({ version: versionSchema, integrity: integritySchema.nullable() })
export type ReleaseIdentity = z.infer<typeof identitySchema>
export type ObservedIdentity = z.infer<typeof observedIdentitySchema>
export const idSchema = z.uuid()
export const phases = ['checking', 'verifying', 'staging', 'ready_to_apply', 'switching', 'waiting_for_service', 'service_ready', 'rolling_back', 'rolled_back', 'failed', 'recovery_required'] as const
export const errors = ['verification_failed', 'staging_failed', 'busy', 'incompatible', 'worker_failed', 'startup_failed', 'rollback_failed', 'interrupted'] as const
export const jobSchema = z.strictObject({
  id: idSchema, phase: z.enum(phases), source: observedIdentitySchema, target: identitySchema,
  nonce: z.string().regex(/^[a-f0-9]{64}$/), parentPid: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(),
  error: z.enum(errors).optional(),
})
export type UpdateJob = z.infer<typeof jobSchema>
export type UpdatePhase = UpdateJob['phase']
export type UpdateError = NonNullable<UpdateJob['error']>
export const publicJobSchema = jobSchema.omit({ nonce: true, parentPid: true })
export type PublicUpdateJob = z.infer<typeof publicJobSchema>
export const markerSchema = z.strictObject({ id: idSchema, nonce: z.string().regex(/^[a-f0-9]{64}$/), boot: observedIdentitySchema, pid: z.number().int().positive(), kind: z.enum(['target', 'source']) })
export const terminal = (phase: UpdatePhase) => ['service_ready', 'rolled_back', 'failed', 'recovery_required'].includes(phase)
export function publicJob(job: UpdateJob): PublicUpdateJob { const { nonce, parentPid, ...safe } = job; return safe }
export function sameIdentity(a: ObservedIdentity, b: ObservedIdentity): boolean { return a.version === b.version && a.integrity === b.integrity }
export function planDecision(current: ObservedIdentity, target: ReleaseIdentity): 'update_required' | 'local_ahead' | 'up_to_date' | 'identity_unknown' {
  if (semverGt(current.version, target.version)) return 'local_ahead'
  if (current.version === target.version) return current.integrity === target.integrity ? 'up_to_date' : 'identity_unknown'
  return 'update_required'
}
export const planSchema = z.strictObject({ service: observedIdentitySchema, target: identitySchema, decision: z.enum(['update_required', 'local_ahead', 'up_to_date', 'identity_unknown']), compatible: z.boolean(), reason: z.string().regex(/^[a-z_]{1,50}$/).nullable(), platform: z.enum(['win32', 'unsupported']), coordinator: z.literal(1), activeJob:publicJobSchema.nullable().optional() })
export type UpdatePlan = z.infer<typeof planSchema>
export interface CoordinatedUpdateApi {
  planUpdate(): Promise<import('../../core/types.js').ToolResult>
  beginUpdate(target: ReleaseIdentity): Promise<import('../../core/types.js').ToolResult>
  updateStatus(id: string): Promise<import('../../core/types.js').ToolResult>
  activateUpdate(id: string): Promise<import('../../core/types.js').ToolResult>
  confirmUpdateReady(id: string): Promise<import('../../core/types.js').ToolResult>
}
