import { describe, it, expect, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SettingsStore } from '../src/service/settings.js'
import { AttemptLimiter } from '../src/service/attempts.js'
import { PolicyApprover } from '../src/service/policy-approver.js'
import type { ApprovalMode, MasterPasswordChecker, ProtectedPrompt } from '../src/core/types.js'

async function setup(opts: { mode?: ApprovalMode; phrase?: string; platform?: NodeJS.Platform; clock?: { t: number } } = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'uchan-pol-'))
  const settings = new SettingsStore(join(dir, 'settings.json'))
  await settings.update({ mode: opts.mode ?? 'easy', phrase: opts.phrase ?? '' })
  const clock = opts.clock ?? { t: 0 }
  const limiter = new AttemptLimiter(5, 900000, () => clock.t)
  const prompt = { confirm: vi.fn(async () => true), askPassword: vi.fn(async (): Promise<string | null> => 'pw') }
  const checker = { verify: vi.fn(async (_p: string) => true) }
  const approver = new PolicyApprover({
    prompt: prompt as ProtectedPrompt,
    checker: checker as MasterPasswordChecker,
    settings,
    limiter,
    platform: opts.platform ?? 'win32',
  })
  return { dir, settings, limiter, prompt, checker, approver, clock }
}

describe('PolicyApprover', () => {
  it('easy mode confirms', async () => {
    const s = await setup()
    expect(await s.approver.ask('t', ['l'])).toBe(true)
    expect(s.prompt.askPassword).not.toHaveBeenCalled()
    await rm(s.dir, { recursive: true })
  })

  it('hardcore needs the right password', async () => {
    const s = await setup({ mode: 'hardcore' })
    expect(await s.approver.ask('t', [])).toBe(true)
    s.checker.verify.mockResolvedValue(false)
    const fail = vi.spyOn(s.limiter, 'fail')
    expect(await s.approver.ask('t', [])).toBe(false)
    expect(fail).toHaveBeenCalledTimes(1)
    s.prompt.askPassword.mockResolvedValue(null)
    expect(await s.approver.ask('t', [])).toBe(false)
    expect(s.prompt.confirm).not.toHaveBeenCalled()
    await rm(s.dir, { recursive: true })
  })

  it('darwin is always hardcore', async () => {
    const s = await setup({ mode: 'easy', platform: 'darwin' })
    expect(await s.approver.effectiveMode()).toBe('hardcore')
    expect(await s.approver.ask('t', [])).toBe(true)
    expect(s.prompt.askPassword).toHaveBeenCalled()
    expect(s.prompt.confirm).not.toHaveBeenCalled()
    await rm(s.dir, { recursive: true })
  })

  it('locks out after 5 wrong passwords', async () => {
    const s = await setup({ mode: 'hardcore' })
    s.checker.verify.mockResolvedValue(false)
    for (let i = 0; i < 5; i++) expect(await s.approver.ask('t', [])).toBe(false)
    s.prompt.askPassword.mockClear()
    expect(await s.approver.ask('t', [])).toBe(false)
    expect(s.prompt.askPassword).not.toHaveBeenCalled()
    s.clock.t += 900000
    await s.approver.ask('t', [])
    expect(s.prompt.askPassword).toHaveBeenCalledTimes(1)
    await rm(s.dir, { recursive: true })
  })

  it('passes the phrase', async () => {
    const s = await setup({ phrase: 'blue otter' })
    await s.approver.ask('t', ['x'])
    await s.settings.update({ mode: 'hardcore' })
    await s.approver.ask('t', ['x'])
    await s.approver.askPassword('t', ['x'])
    const reqs = [...s.prompt.confirm.mock.calls, ...s.prompt.askPassword.mock.calls].map((c) => (c as unknown[])[0])
    expect(reqs).toHaveLength(3)
    for (const r of reqs) expect(r).toMatchObject({ phrase: 'blue otter' })
    await rm(s.dir, { recursive: true })
  })

  it('serializes prompts', async () => {
    const s = await setup()
    let release!: (v: boolean) => void
    s.prompt.confirm.mockImplementationOnce(() => new Promise<boolean>((r) => (release = r)))
    const a = s.approver.ask('a', [])
    const b = s.approver.ask('b', [])
    await new Promise((r) => setTimeout(r, 50))
    expect(s.prompt.confirm).toHaveBeenCalledTimes(1)
    release(true)
    expect(await a).toBe(true)
    expect(await b).toBe(true)
    expect(s.prompt.confirm).toHaveBeenCalledTimes(2)
    await rm(s.dir, { recursive: true })
  })
})

describe('SettingsStore', () => {
  it('defaults when missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uchan-set-'))
    expect(await new SettingsStore(join(dir, 'a', 's.json')).get()).toEqual({ mode: 'easy', phrase: '', idleLockMs: 43200000 })
    await rm(dir, { recursive: true })
  })
})
