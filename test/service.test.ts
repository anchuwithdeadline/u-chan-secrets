import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { AllowlistStore } from '../src/core/allowlist.js'
import { CoreService } from '../src/core/service.js'
import { UserFacingError, type AllowEntry, type AuditEvent, type VaultClient, type VaultStatus } from '../src/core/types.js'
import type { FillOutcome } from '../src/core/login-filler.js'

const entry: AllowEntry = { domain: 'example.com', hosts: ['example.com'], loginUrl: 'https://example.com/login', item: 'ex' }
let dir: string
let store: AllowlistStore
let events: AuditEvent[]
let vault: VaultClient & { getLogin: ReturnType<typeof vi.fn> }
let approve: Mock<(title: string, lines: string[]) => Promise<boolean>>
let fill: { impl: (entry: AllowEntry, getCreds: () => Promise<unknown>) => Promise<FillOutcome> }
let runs: AllowEntry[]
let mode: 'easy' | 'hardcore'
let svc: CoreService
let vaultStatus: VaultStatus

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ucs-svc-'))
  store = new AllowlistStore(join(dir, 'allow.json'))
  events = []
  vaultStatus = 'unlocked'
  mode = 'hardcore'
  runs = []
  fill = { impl: async (_e, getCreds) => { await getCreds(); return { status: 'logged_in' } } }
  vault = { status: async () => vaultStatus, unlock: async () => true, lock: async () => {}, getLogin: vi.fn(async () => ({ username: 'u', password: 'hunter2' })) }
  approve = vi.fn(async (_t: string, _l: string[]) => true)
  const login = { run: async (e: AllowEntry, g: () => Promise<never>) => { runs.push(e); return fill.impl(e, g) } }
  svc = new CoreService({ vault, allowlist: store, approver: { ask: approve }, audit: { record: async (e) => void events.push(e) }, login, mode: async () => mode })
})
afterEach(async () => {
  vi.restoreAllMocks()
  await rm(dir, { recursive: true, force: true })
})

describe('login', () => {
  it('rejects unknown domain without touching vault', async () => {
    expect(await svc.login('nope.com')).toEqual({ ok: false, message: 'domain is not allowlisted — use request_allow' })
    expect(vault.getLogin).not.toHaveBeenCalled()
  })
  it('uses the runner with the stored entry', async () => {
    await store.upsert(entry)
    expect(await svc.login('example.com')).toEqual({ ok: true, message: 'logged in' })
    expect(runs).toEqual([entry])
  })
  it('logs in and audits', async () => {
    await store.upsert(entry)
    expect(await svc.login('Example.com')).toEqual({ ok: true, message: 'logged in' })
    expect(events).toEqual([{ action: 'login', domain: 'example.com', result: 'ok' }])
  })
  it('normalizes URL-shaped domain', async () => {
    await store.upsert(entry)
    expect((await svc.login('https://Example.com/x')).ok).toBe(true)
    expect(events[0].domain).toBe('example.com')
  })
  it('rejects invalid domain', async () => {
    const out = await svc.login('https:///')
    expect(out.ok).toBe(false)
    expect(out.message).toMatch(/invalid/)
  })
  it('reports already logged in', async () => {
    await store.upsert(entry)
    fill.impl = async () => ({ status: 'already_logged_in' })
    expect(await svc.login('example.com')).toEqual({ ok: true, message: 'already logged in' })
    expect(events[0].result).toBe('already')
  })
  it('passes failed reason through', async () => {
    await store.upsert(entry)
    fill.impl = async () => ({ status: 'failed', reason: 'unexpected host evil.com' })
    expect(await svc.login('example.com')).toEqual({ ok: false, message: 'unexpected host evil.com' })
    expect(events[0].result).toBe('failed: unexpected host evil.com')
  })
  it('returns UserFacingError message', async () => {
    await store.upsert(entry)
    vault.getLogin.mockRejectedValue(new UserFacingError('vault locked — run scripts/unlock.ps1'))
    expect(await svc.login('example.com')).toEqual({ ok: false, message: 'vault locked — run scripts/unlock.ps1' })
  })
  it('hides internal errors and redacts credentials from stderr', async () => {
    await store.upsert(entry)
    fill.impl = async (_e, getCreds) => { await getCreds(); throw new Error('boom hunter2') }
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const out = await svc.login('example.com')
    expect(out).toEqual({ ok: false, message: 'internal error' })
    expect(JSON.stringify(out)).not.toContain('hunter2')
    expect(JSON.stringify(events)).not.toContain('hunter2')
    expect(err).toHaveBeenCalled()
    expect(err.mock.calls.flat().join(' ')).not.toContain('hunter2')
    expect(err.mock.calls.flat().join(' ')).toContain('[REDACTED]')
  })
  it('does not break on audit failure', async () => {
    await store.upsert(entry)
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const s = new CoreService({
      vault, allowlist: store, approver: { ask: approve },
      audit: { record: async () => { throw new Error('disk') } },
      login: { run: async () => ({ status: 'logged_in' }) }, mode: async () => 'easy',
    })
    expect(await s.login('example.com')).toEqual({ ok: true, message: 'logged in' })
    expect(err).toHaveBeenCalledWith('audit write failed')
  })
})

describe('requestAllow', () => {
  it('denied leaves allowlist unchanged', async () => {
    approve.mockResolvedValue(false)
    expect(await svc.requestAllow('example.com', 'https://example.com/login', 'ex')).toEqual({ ok: false, message: 'denied' })
    expect(await store.list()).toEqual([])
    expect(events).toEqual([{ action: 'request_allow', domain: 'example.com', result: 'denied' }])
  })
  it('approved stores entry and shows normalized lines', async () => {
    expect(await svc.requestAllow('Example.com', 'https://auth.example.com/login', 'ex')).toEqual({ ok: true, message: 'approved' })
    expect((await store.list())[0]).toMatchObject({ domain: 'example.com', hosts: ['example.com', 'auth.example.com'] })
    expect(approve).toHaveBeenCalledWith('U-Chan Secrets', [
      'Allow the AI to sign in?', 'Domain: example.com', 'Login URL: https://auth.example.com/login',
      'Bitwarden item: ex', 'Hosts: example.com, auth.example.com',
    ])
    expect(events[0].result).toBe('approved')
  })
  it('accumulates hosts from existing entry', async () => {
    await store.upsert(entry)
    await svc.requestAllow('example.com', 'https://auth.example.com/login', 'ex')
    expect((await store.get('example.com'))!.hosts).toEqual(['example.com', 'auth.example.com'])
  })
  it('strips control characters before the dialog', async () => {
    await svc.requestAllow('example.com\r\n', 'https://example.com/login ', 'it\nem\u0007\t')
    const lines = approve.mock.calls[0][1] as string[]
    expect(lines).toHaveLength(5)
    expect(lines[3]).toBe('Bitwarden item: item')
    expect((await store.list())[0].item).toBe('item')
  })
  it('strips format chars and shows normalized URL in dialog', async () => {
    await svc.requestAllow('example.com', 'https://example.com/lo\u202Egin', 'i\u202Etem')
    const lines = approve.mock.calls[0][1] as string[]
    expect(lines.join('|')).not.toContain('\u202E')
    expect(lines[2]).toBe('Login URL: https://example.com/login')
    expect(lines[3]).toBe('Bitwarden item: item')
  })
  it('requestAllow shows and stores selectors', async () => {
    await svc.requestAllow('example.com', 'https://example.com/login', 'ex', { username: '#e\n' })
    const lines = approve.mock.calls[0][1] as string[]
    expect(lines).toContain('Selectors: username=#e')
    expect((await store.list())[0].selectors).toEqual({ username: '#e' })
  })
  it('drops unknown selector keys', async () => {
    await svc.requestAllow('example.com', 'https://example.com/login', 'ex', { username: '#e', evil: 'x' } as never)
    expect((await store.list())[0].selectors).toEqual({ username: '#e' })
  })
  it('shows kept selectors when re-requesting without any', async () => {
    await store.upsert({ ...entry, selectors: { password: '#p' } })
    await svc.requestAllow('example.com', 'https://example.com/login', 'ex')
    expect(approve.mock.calls[0][1]).toContain('Selectors: password=#p')
    expect((await store.list())[0].selectors).toEqual({ password: '#p' })
  })
  it('rejects http without asking', async () => {
    const out = await svc.requestAllow('example.com', 'http://example.com/login', 'ex')
    expect(out.ok).toBe(false)
    expect(approve).not.toHaveBeenCalled()
    expect(events[0].result).toMatch(/^failed: /)
  })
})

describe('revoke / list / status', () => {
  it('revoke removes without asking', async () => {
    await store.upsert(entry)
    expect((await svc.revoke('example.com')).ok).toBe(true)
    expect(await store.list()).toEqual([])
    expect(approve).not.toHaveBeenCalled()
    expect(events).toEqual([{ action: 'revoke', domain: 'example.com', result: 'ok' }])
  })
  it('revoke accepts scheme/path and audits normalized domain', async () => {
    await store.upsert(entry)
    expect((await svc.revoke('HTTPS://Example.com/path')).ok).toBe(true)
    expect(events[0].domain).toBe('example.com')
    expect((await svc.revoke('  ')).ok).toBe(false)
  })
  it('lists empty allowlist', async () => {
    expect(await svc.listAllowed()).toEqual({ ok: true, message: 'allowlist is empty' })
  })
  it('revoke of unknown domain audits not found', async () => {
    expect((await svc.revoke('x.com')).ok).toBe(false)
    expect(events[0].result).toBe('not found')
  })
  it('lists entries', async () => {
    await store.upsert({ ...entry, hosts: ['example.com', 'a.example.com'] })
    expect(await svc.listAllowed()).toEqual({ ok: true, message: 'example.com — ex — example.com, a.example.com' })
  })
  it('status shows mode', async () => {
    expect(await svc.status()).toEqual({ ok: true, message: 'vault: unlocked; mode: hardcore' })
    mode = 'easy'
    expect((await svc.status()).message).toBe('vault: unlocked; mode: easy')
    vaultStatus = 'locked'
    expect(await svc.status()).toEqual({ ok: false, message: 'vault: locked; mode: easy' })
  })
})
