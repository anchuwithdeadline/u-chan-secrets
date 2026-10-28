import { afterEach, beforeEach, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { AllowlistStore } from '../src/core/allowlist.js'
import { CoreService } from '../src/core/service.js'
import { GrantCoordinator } from '../src/service/grants.js'
let dir: string, store: AllowlistStore, clock: number, mono: number, grants: GrantCoordinator
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'ucs-grants-')); store = new AllowlistStore(join(dir, 'allow.json')); clock = 1_800_000_000_000; mono = 0; grants = new GrantCoordinator(store, { now: () => clock, monotonic: () => mono }) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })
const entry = { domain: 'a.com', hosts: ['a.com'], loginUrl: 'https://a.com/login', item: 'A' }
function service(overrides: any = {}) {
  return new CoreService({ allowlist: store, grants, vault: { status: async () => 'unlocked', getLogin: async () => ({ username: 'u', password: 'pw' }) } as any,
    approver: { ask: async () => true }, audit: { record: async () => {}, readTail: async () => [] },
    login: { run: async () => ({ status: 'logged_in' }) }, mode: async () => 'hardcore', ...overrides })
}
it('only one concurrent login can use a once grant, including after restart', async () => {
  const svc = service()
  expect((await svc.requestAllow('a.com', entry.loginUrl, 'A', undefined, { grant: { kind: 'once' } })).ok).toBe(true)
  const results = await Promise.all([svc.login('a.com'), svc.login('a.com')])
  expect(results.filter(r => r.ok)).toHaveLength(1)
  expect(results.find(r => !r.ok)?.code).toBe('grant_exhausted')
  expect((await store.get('a.com'))?.remainingUses).toBe(0)
  expect((await service({ grants: new GrantCoordinator(store) }).login('a.com')).code).toBe('grant_exhausted')
})
it('does not consume a once grant on locked-vault or Chrome preflight failure', async () => {
  await store.upsert({ ...entry, remainingUses: 1 })
  expect((await service({ vault: { status: async () => 'locked' } }).login('a.com')).code).toBe('vault_locked')
  expect((await store.get('a.com'))?.remainingUses).toBe(1)
})
it('consumes a reserved attempt even when login fails', async () => {
  await store.upsert({ ...entry, remainingUses: 1 })
  expect((await service({ login: { run: async () => ({ status: 'failed', reason: 'failed' }) } }).login('a.com')).ok).toBe(false)
  expect((await store.get('a.com'))?.remainingUses).toBe(0)
})
it('enforces exact expiry and rechecks before transferring', async () => {
  await store.upsert({ ...entry, expiresAt: new Date(clock + 60_000).toISOString() })
  const svc = service({ login: { run: async (_e: unknown, _c: unknown, opts: any) => { clock += 60_000; mono += 60_000; await opts.beforeTransfer(); return { status: 'logged_in' } } } })
  expect((await svc.login('a.com')).code).toBe('grant_expired')
  expect((await service({ grants: new GrantCoordinator(store, { now: () => clock, monotonic: () => mono }) }).login('a.com')).code).toBe('grant_expired')
})
it('fails closed on malformed persisted policy instead of treating it as permanent', async () => {
  await writeFile(join(dir, 'allow.json'), JSON.stringify([{ ...entry, expiresAt: 'invalid' }]))
  expect((await service().login('a.com')).ok).toBe(false)
})
it('invalidates timed grants after backward clock movement and permits explicit renewal', async () => {
  const svc = service()
  await svc.requestAllow('a.com', entry.loginUrl, 'A', undefined, { grant: { kind: 'timed', minutes: 1 } })
  mono += 2000; clock -= 5000
  expect((await svc.login('a.com')).code).toBe('grant_expired')
  expect((await svc.requestAllow('a.com', entry.loginUrl, 'A', undefined, { grant: { kind: 'timed', minutes: 1 } })).ok).toBe(true)
  expect((await svc.login('a.com')).ok).toBe(true)
})
it('does not approve a timed request that expired while its window was open', async () => {
  const svc = service({ approver: { ask: async () => { clock += 60_000; mono += 60_000; return true } } })
  expect((await svc.requestAllow('a.com', entry.loginUrl, 'A', undefined, { grant: { kind: 'timed', minutes: 1 } })).code).toBe('grant_expired')
  expect(await store.get('a.com')).toBeUndefined()
})
it('accepts duration boundaries and rejects out-of-range or fractional policies without approval', async () => {
  const svc = service()
  for (const minutes of [1, 1440]) {
    expect((await svc.requestAllow('a.com', entry.loginUrl, 'A', undefined, { grant: { kind: 'timed', minutes } })).ok).toBe(true)
    expect((await store.get('a.com'))?.expiresAt).toBe(new Date(clock + minutes * 60000).toISOString())
  }
  for (const minutes of [0, 1441, 1.5]) expect((await svc.requestAllow('a.com', entry.loginUrl, 'A', undefined, { grant: { kind: 'timed', minutes } })).code).toBe('invalid_policy')
})
it('does not consume a once grant when Chrome preflight fails', async () => {
  await store.upsert({ ...entry, remainingUses: 1 })
  expect((await service({ login: { preflight: async () => { throw new Error('offline') } } }).login('a.com')).ok).toBe(false)
  expect((await store.get('a.com'))?.remainingUses).toBe(1)
})
it('revocation waits for an earlier login and queue recovers from failed operations', async () => {
  await store.upsert(entry)
  let release!: () => void, started!: () => void
  const running = new Promise<void>(resolve => { started = resolve })
  const gate = new Promise<void>(resolve => { release = resolve })
  const svc = service({ login: { run: async () => { started(); await gate; return { status: 'logged_in' } } } })
  const first = svc.login('a.com')
  await running
  let revoked = false
  const revoke = svc.revoke('a.com').then(r => { revoked = true; return r })
  await new Promise(resolve => setTimeout(resolve, 5))
  expect(revoked).toBe(false)
  release()
  expect((await first).ok).toBe(true)
  expect((await revoke).ok).toBe(true)
  expect((await svc.login('a.com')).code).toBe('grant_missing')
  expect((await svc.listAllowed()).ok).toBe(true)
})
it('bounds preflight with the same deadline and releases the grant queue', async () => {
  await store.upsert({ ...entry, remainingUses: 1 })
  const svc = service({
    loginTimeoutMs: 20,
    login: { preflight: async (signal?: AbortSignal) => new Promise((_r, reject) => signal?.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })) },
  })
  const result = await Promise.race([svc.login('a.com'), new Promise(resolve => setTimeout(() => resolve('pending'), 200))])
  expect(result).toMatchObject({ code: 'login_timeout' })
  expect((await svc.revoke('a.com')).ok).toBe(true)
})
