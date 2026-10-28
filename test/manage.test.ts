import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ManagementService } from '../src/service/manage.js'
import { AllowlistStore } from '../src/core/allowlist.js'
import { GrantCoordinator } from '../src/service/grants.js'
const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
async function setup(actions: unknown[]) {
  const dir = await mkdtemp(join(tmpdir(), 'ucs-manage-')); dirs.push(dir)
  const store = new AllowlistStore(join(dir, 'grants.json'))
  await store.upsert({ domain: 'a.com', hosts: ['a.com'], loginUrl: 'https://a.com/login', item: 'A', selectors: { password: 'SECRET selector' } })
  const calls: string[] = [], snapshots: unknown[] = []
  const manager = new ManagementService({
    store, grants: new GrantCoordinator(store), phrase: async () => 'trusted phrase',
    vault: { status: async () => 'locked' },
    audit: { readTail: async () => [{ ts: new Date(0).toISOString(), action: 'login', domain: 'a.com', result: 'SECRET raw result' }] },
    diagnose: async () => ({ assets: 'pass', permissions: 'pass', vault: 'locked', serviceVersion: '4.0.0', browser: 'pass' }),
    show: async req => { snapshots.push(req); return actions.shift() as any },
    lock: async () => { calls.push('lock'); return { ok: true, message: 'locked' } },
    unlock: async () => { calls.push('unlock'); return { ok: true, message: 'unlocked' } },
    revoke: async domain => { calls.push('revoke ' + domain); await store.remove(domain); return { ok: true, message: 'revoked' } },
  })
  return { manager, calls, snapshots, store }
}
it('routes only lock, unlock and existing-domain revocation and keeps sensitive fields out of snapshots', async () => {
  const { manager, calls, snapshots, store } = await setup([{ action: 'lock' }, { action: 'unlock' }, { action: 'revoke', domain: 'a.com' }, { action: 'close' }])
  expect((await manager.open()).ok).toBe(true)
  expect(calls).toEqual(['lock', 'unlock', 'revoke a.com'])
  expect(await store.get('a.com')).toBeUndefined()
  expect(JSON.stringify(snapshots)).not.toContain('SECRET')
  expect(JSON.stringify(snapshots)).toContain('Service version: 4.0.0')
  expect(JSON.stringify(snapshots)).toContain('Service browser: pass')
  expect(JSON.stringify(snapshots)).toContain('Next step: use Unlock')
})
it('rejects unknown actions and targets without granting or revoking anything', async () => {
  for (const action of [{ action: 'approve' }, { action: 'revoke', domain: 'other.com' }]) {
    const { manager, calls, store } = await setup([action])
    expect((await manager.open()).ok).toBe(false)
    expect(calls).toEqual([])
    expect(await store.get('a.com')).toBeDefined()
  }
})
it('closing or helper timeout does not change state', async () => {
  const { manager, calls } = await setup([null])
  expect((await manager.open()).ok).toBe(true)
  expect(calls).toEqual([])
})
it('paginates grants so long lists stay within native transport bounds', async () => {
  const { manager, store, snapshots } = await setup([{ action: 'next' }, { action: 'close' }])
  for (let i = 0; i < 25; i++) await store.upsert({ domain: 'a' + i + '.com', hosts: ['a' + i + '.com'], loginUrl: 'https://a' + i + '.com/login', item: 'A' })
  expect((await manager.open()).ok).toBe(true)
  expect((snapshots[0] as any).domains).toHaveLength(20)
  expect((snapshots[1] as any).domains).toHaveLength(6)
})
