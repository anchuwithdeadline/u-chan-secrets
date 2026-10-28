import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AllowlistStore } from '../src/core/allowlist.js'
import { ControlService } from '../src/service/control.js'
import { SettingsStore } from '../src/service/settings.js'
import { AttemptLimiter } from '../src/service/attempts.js'
import type { AuditEvent } from '../src/core/types.js'

let dir: string
let events: AuditEvent[]
let vault: { status: ReturnType<typeof vi.fn>; unlock: ReturnType<typeof vi.fn>; lock: ReturnType<typeof vi.fn>; verify: ReturnType<typeof vi.fn> }
let approver: { askPassword: ReturnType<typeof vi.fn>; ask: ReturnType<typeof vi.fn> }
let limiter: AttemptLimiter
let settings: SettingsStore
let allowlist: AllowlistStore

const make = (platform: NodeJS.Platform = 'win32') =>
  new ControlService({
    vault: vault as never, approver: approver as never, limiter, settings, allowlist,
    audit: { record: async (e) => void events.push(e), readTail: async () => [] }, platform,
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ucs-ctl-'))
  events = []
  vault = { status: vi.fn(async () => 'locked'), unlock: vi.fn(async () => true), lock: vi.fn(async () => {}), verify: vi.fn(async () => true) }
  approver = { askPassword: vi.fn(async () => 'pw'), ask: vi.fn(async () => true) }
  limiter = new AttemptLimiter()
  settings = new SettingsStore(join(dir, 'settings.json'))
  allowlist = new AllowlistStore(join(dir, 'allow.json'))
})
afterEach(() => rm(dir, { recursive: true, force: true }))

describe('control: unlock', () => {
  it('unlocks and audits without the password', async () => {
    expect(await make().unlock()).toEqual({ ok: true, message: 'unlocked' })
    expect(vault.unlock).toHaveBeenCalledWith('pw')
    expect(events).toEqual([{ action: 'unlock', domain: '', result: 'ok' }])
    expect(JSON.stringify(events)).not.toContain('pw')
  })
  it('wrong password counts a failure', async () => {
    vault.unlock.mockResolvedValue(false)
    const fail = vi.spyOn(limiter, 'fail')
    expect(await make().unlock()).toEqual({ ok: false, message: 'wrong password' })
    expect(fail).toHaveBeenCalled()
    expect(events[0]).toMatchObject({ action: 'unlock', result: 'failed: wrong password' })
  })
  it('cancel', async () => {
    approver.askPassword.mockResolvedValue(null)
    expect(await make().unlock()).toEqual({ ok: false, message: 'cancelled' })
  })
  it('blocked returns the lockout message without prompting', async () => {
    for (let i = 0; i < 5; i++) limiter.fail()
    expect(await make().unlock()).toEqual({ ok: false, message: 'too many wrong passwords — try again in 15 minutes' })
    expect(approver.askPassword).not.toHaveBeenCalled()
  })
  it('success resets the limiter', async () => {
    const reset = vi.spyOn(limiter, 'reset')
    await make().unlock()
    expect(reset).toHaveBeenCalled()
  })
})

describe('control: unlock when unauthenticated', () => {
  it('returns the login message without prompting or counting', async () => {
    vault.status.mockResolvedValue('unauthenticated')
    const fail = vi.spyOn(limiter, 'fail')
    expect(await make().unlock()).toEqual({ ok: false, message: 'not logged in to Bitwarden — run u-chan install' })
    expect(approver.askPassword).not.toHaveBeenCalled()
    expect(fail).not.toHaveBeenCalled()
  })
})

describe('control: lock', () => {
  it('locks', async () => {
    expect(await make().lock()).toEqual({ ok: true, message: 'locked' })
    expect(vault.lock).toHaveBeenCalled()
    expect(events[0]).toMatchObject({ action: 'lock', result: 'ok' })
  })
})

describe('control: mode', () => {
  it('hardcore saves with no prompt', async () => {
    expect((await make().setMode('hardcore')).ok).toBe(true)
    expect((await settings.get()).mode).toBe('hardcore')
    expect(approver.askPassword).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ action: 'mode', result: 'hardcore' })
  })
  it('easy on win32 requires the master password', async () => {
    await settings.update({ mode: 'hardcore' })
    expect((await make().setMode('easy')).ok).toBe(true)
    expect(vault.verify).toHaveBeenCalledWith('pw')
    expect((await settings.get()).mode).toBe('easy')
  })
  it('easy with a wrong password is refused and counted', async () => {
    await settings.update({ mode: 'hardcore' })
    vault.verify.mockResolvedValue(false)
    const fail = vi.spyOn(limiter, 'fail')
    expect(await make().setMode('easy')).toEqual({ ok: false, message: 'wrong password' })
    expect(fail).toHaveBeenCalled()
    expect((await settings.get()).mode).toBe('hardcore')
  })
  it('easy cancelled or blocked changes nothing', async () => {
    await settings.update({ mode: 'hardcore' })
    approver.askPassword.mockResolvedValue(null)
    expect((await make().setMode('easy')).ok).toBe(false)
    expect((await settings.get()).mode).toBe('hardcore')
  })
  it('easy on darwin is unavailable', async () => {
    expect(await make('darwin').setMode('easy')).toEqual({ ok: false, message: 'easy mode is not available on macOS' })
    expect(approver.askPassword).not.toHaveBeenCalled()
  })
})

describe('control: importV1', () => {
  it('asks for each valid entry', async () => {
    const e = (d: string) => ({ domain: d, hosts: [d], loginUrl: `https://${d}/login`, item: d })
    approver.ask.mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    const out = await make().importV1([e('a.com'), { bad: 1 }, e('b.com')])
    expect(out).toEqual({ ok: true, message: 'imported 1 of 2' })
    expect((await allowlist.list()).map((x) => x.domain)).toEqual(['a.com'])
    expect(approver.ask).toHaveBeenCalledTimes(2)
    expect(events[0]).toMatchObject({ action: 'import', result: 'imported 1 of 2' })
  })
})

describe('control: importV1 sanitizing', () => {
  const base = { domain: 'a.com', hosts: ['a.com'], loginUrl: 'https://a.com/login', item: 'a' }
  it('stores only known fields and shows valid selectors', async () => {
    const out = await make().importV1([{ ...base, evil: 1, selectors: { username: '#u\n', bogus: 'x', password: 5 } }])
    expect(out.message).toBe('imported 1 of 1')
    const [stored] = await allowlist.list()
    expect(stored).toEqual({ ...base, selectors: { username: '#u' } })
    expect(approver.ask.mock.calls[0][1]).toContain('Selectors: username=#u')
  })
  it('drops selectors with no valid keys', async () => {
    await make().importV1([{ ...base, selectors: { bogus: 'x', password: 5 } }])
    expect((await allowlist.list())[0].selectors).toBeUndefined()
    expect((approver.ask.mock.calls[0][1] as string[]).some((l) => l.startsWith('Selectors'))).toBe(false)
  })
  it('rejects http loginUrl without asking', async () => {
    expect(await make().importV1([{ ...base, loginUrl: 'http://a.com/login' }])).toEqual({ ok: true, message: 'imported 0 of 1' })
    expect(approver.ask).not.toHaveBeenCalled()
  })
  it('cleans hosts in dialog and storage', async () => {
    await make().importV1([{ ...base, hosts: ['a.com', 'ev‮il.com\n', '‮'] }])
    expect(await allowlist.list()).toEqual([{ ...base, hosts: ['a.com', 'evil.com'] }])
    const lines = approver.ask.mock.calls[0][1] as string[]
    expect(lines.join('|')).not.toMatch(/[‮\n]/)
    expect(lines).toContain('Hosts: a.com, evil.com')
  })
})

describe('control: audit', () => {
  it('formats records', async () => {
    const records = [
      { ts: '2026-10-28T01:00:00.000Z', action: 'login' as const, domain: 'github.com', result: 'ok' },
      { ts: '2026-10-28T01:05:00.000Z', action: 'unlock' as const, domain: '', result: 'ok' },
    ]
    const ctl = new ControlService({
      vault: vault as never, approver: approver as never, limiter, settings, allowlist,
      audit: { record: async (e: AuditEvent) => void events.push(e), readTail: async () => records },
      platform: 'win32',
    })
    const res = await ctl.audit()
    expect(res).toEqual({
      ok: true,
      message: '2026-10-28T01:00:00.000Z  login          github.com  ok\n2026-10-28T01:05:00.000Z  unlock         ok',
    })
  })

  it('returns clean message when audit log is empty', async () => {
    const ctl = new ControlService({
      vault: vault as never, approver: approver as never, limiter, settings, allowlist,
      audit: { record: async (e: AuditEvent) => void events.push(e), readTail: async () => [] },
      platform: 'win32',
    })
    expect(await ctl.audit()).toEqual({ ok: true, message: 'no audit log entries' })
  })

  it('does not append an audit event', async () => {
    const recordSpy = vi.fn(async () => {})
    const ctl = new ControlService({
      vault: vault as never, approver: approver as never, limiter, settings, allowlist,
      audit: { record: recordSpy, readTail: async () => [] } as never,
      platform: 'win32',
    })
    await ctl.audit()
    expect(recordSpy).not.toHaveBeenCalled()
    expect(events).toHaveLength(0)
  })
})

describe('control: update', () => {
  it('records audit event on success', async () => {
    const updater = { update: vi.fn(async () => ({ ok: true, message: 'updated to 2.1.0' })) }
    const ctl = new ControlService({
      vault: vault as never, approver: approver as never, limiter, settings, allowlist,
      audit: { record: async (e) => void events.push(e), readTail: async () => [] }, platform: 'win32',
      updater,
    })
    const res = await ctl.update()
    expect(res).toEqual({ ok: true, message: 'updated to 2.1.0' })
    expect(events).toEqual([{ action: 'update', domain: '', result: 'updated to 2.1.0' }])
  })

  it('records audit event on failure', async () => {
    const updater = { update: vi.fn(async () => ({ ok: false, message: 'integrity check failed' })) }
    const ctl = new ControlService({
      vault: vault as never, approver: approver as never, limiter, settings, allowlist,
      audit: { record: async (e) => void events.push(e), readTail: async () => [] }, platform: 'win32',
      updater,
    })
    const res = await ctl.update()
    expect(res).toEqual({ ok: false, message: 'integrity check failed' })
    expect(events).toEqual([{ action: 'update', domain: '', result: 'failed: integrity check failed' }])
  })
})

