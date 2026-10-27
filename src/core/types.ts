export interface AllowEntry {
  domain: string
  hosts: string[]
  loginUrl: string
  item: string
  selectors?: { username?: string; password?: string; submit?: string }
}
export interface Credentials { username: string; password: string }
export type VaultStatus = 'unlocked' | 'locked' | 'unauthenticated' | 'unavailable'
export interface VaultClient {
  status(): Promise<VaultStatus>
  getLogin(item: string): Promise<Credentials>
}
export interface Approver { ask(title: string, lines: string[]): Promise<boolean> }
export type AuditEvent = { action: 'login' | 'request_allow' | 'revoke'; domain: string; result: string }
export interface AuditLog { record(event: AuditEvent): Promise<void> }
export type ToolResult = { ok: boolean; message: string }
/** Message is safe to return to the AI. */
export class UserFacingError extends Error {}
export interface CoreApi {
  login(domain: string): Promise<ToolResult>
  requestAllow(domain: string, loginUrl: string, item: string): Promise<ToolResult>
  revoke(domain: string): Promise<ToolResult>
  listAllowed(): Promise<ToolResult>
  status(): Promise<ToolResult>
}
