export interface AllowEntry {
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
}
export interface Approver { ask(title: string, lines: string[]): Promise<boolean> }
export type AuditEvent = { action: 'login' | 'request_allow' | 'revoke'; domain: string; result: string }
export interface AuditLog { record(event: AuditEvent): Promise<void> }
export type Selectors = NonNullable<AllowEntry['selectors']>
export type ApprovalMode = 'easy' | 'hardcore'
export type ToolResult = { ok: boolean; message: string }
/** Message is safe to return to the AI. */
export class UserFacingError extends Error {}
export interface CoreApi {
  login(domain: string): Promise<ToolResult>
  requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors): Promise<ToolResult>
  revoke(domain: string): Promise<ToolResult>
  listAllowed(): Promise<ToolResult>
  status(): Promise<ToolResult>
}
export interface ControlApi {
  unlock(): Promise<ToolResult>
  lock(): Promise<ToolResult>
  setMode(mode: ApprovalMode): Promise<ToolResult>
  importV1(entries: unknown[]): Promise<ToolResult>
}
