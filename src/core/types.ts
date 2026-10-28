import type { FillOutcome } from './login-filler.js'
import type { SessionState } from '../service/session-transfer.js'

export interface AllowEntry {
  success?: SuccessCondition
  expiresAt?: string
  remainingUses?: number
  domain: string
  hosts: string[]
  loginUrl: string
  item: string
  selectors?: { username?: string; password?: string; submit?: string; otp?: string }
}
/** `totp` is the item's TOTP seed (base32 or otpauth:// URI), if any. */
export interface Credentials { username: string; password: string; totp?: string }
export type VaultStatus = 'unlocked' | 'locked' | 'unauthenticated' | 'unavailable'
export interface VaultClient {
  status(): Promise<VaultStatus>
  getLogin(item: string): Promise<Credentials>
  unlock(password: string): Promise<boolean>
  lock(): Promise<void>
}
export interface Approver { ask(title: string, lines: string[]): Promise<boolean> }
export type AuditEvent = { action: 'login' | 'request_allow' | 'revoke' | 'unlock' | 'lock' | 'mode' | 'import' | 'update'; domain: string; result: string }
export interface AuditRecord {
  ts: string
  action: AuditEvent['action']
  domain: string
  result: string
}
export interface AuditLog {
  record(event: AuditEvent): Promise<void>
  readTail(limit?: number): Promise<AuditRecord[]>
}
export type Selectors = NonNullable<AllowEntry['selectors']>
export type ApprovalMode = 'easy' | 'hardcore'
export const RESULT_CODES = ['grant_missing', 'grant_expired', 'grant_exhausted', 'invalid_policy', 'unsupported_service', 'vault_locked', 'vault_unauthenticated', 'vault_unavailable', 'chrome_unavailable', 'unsupported_form', 'needs_human', 'authentication_unconfirmed', 'session_transfer_failed', 'internal_error', 'login_timeout', 'success_condition_failed'] as const
export type ResultCode = typeof RESULT_CODES[number]
export const isResultCode = (value: unknown): value is ResultCode => typeof value === 'string' && (RESULT_CODES as readonly string[]).includes(value)
export type ToolResult = { ok: boolean; message: string; code?: ResultCode }
export type GrantPolicy = { kind: 'once' } | { kind: 'timed'; minutes: number } | { kind: 'permanent' }
export type SuccessCondition = { url: string } | { selector: string }
export interface AllowOptions { grant?: GrantPolicy; success?: SuccessCondition }
/** Message is safe to return to the AI. */
export class UserFacingError extends Error {
  constructor(message: string, public readonly code?: ResultCode) { super(message) }
}
export interface CoreApi {
  login(domain: string): Promise<ToolResult>
  requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors, options?: AllowOptions): Promise<ToolResult>
  revoke(domain: string): Promise<ToolResult>
  listAllowed(): Promise<ToolResult>
  status(): Promise<ToolResult>
}
export interface ControlApi {
  diagnose(): Promise<ToolResult>
  capabilities(): Promise<ToolResult>
  unlock(): Promise<ToolResult>
  lock(): Promise<ToolResult>
  setMode(mode: ApprovalMode): Promise<ToolResult>
  importV1(entries: unknown[]): Promise<ToolResult>
  audit(limit?: number): Promise<ToolResult>
  update(): Promise<ToolResult>
}
export interface ServiceRestarter {
  restart(): Promise<void>
}
export interface PromptRequest { title: string; lines: string[]; phrase: string }
/** Platform window owned by the service. Close, timeout or error → false / null. */
export interface ProtectedPrompt {
  confirm(req: PromptRequest): Promise<boolean>
  askPassword(req: PromptRequest): Promise<string | null>
}
export interface MasterPasswordChecker { verify(password: string): Promise<boolean> }
export interface SessionTarget {
  userAgent(): Promise<string>
  inject(state: SessionState): Promise<void>
}
export interface LoginRunner {
  preflight?(): Promise<void>
  run(entry: AllowEntry, getCreds: () => Promise<Credentials>, options?: { signal?: AbortSignal; beforeTransfer?: () => Promise<void> }): Promise<FillOutcome>
}

export interface RegistryDist {
  tarball: string
  shasum: string
  integrity?: string
  signatures?: Array<{ keyid: string; sig: string }>
  attestations?: { url: string }
}
export interface PackageVersionInfo {
  version: string
  dist: RegistryDist
}
export interface PackageMetadata {
  'dist-tags': { latest: string }
  versions: Record<string, PackageVersionInfo>
}
export interface VerificationOutcome {
  ok: boolean
  targetVersion?: string
  tarball?: Buffer
  error?: string
}
export interface PackageVerifier {
  checkLatest(currentVersion: string): Promise<{ isNewer: boolean; latestVersion: string }>
  verify(targetVersion: string): Promise<VerificationOutcome>
}

