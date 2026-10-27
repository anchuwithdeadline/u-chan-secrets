import { describe, it, expect } from 'vitest'
import { WindowsDialogApprover, type SpawnPs } from '../src/core/approver.js'

function fake(result: { code: number | null; stdout: string } | Error) {
  const calls: { script: string; env: NodeJS.ProcessEnv; timeoutMs: number }[] = []
  const spawnPs: SpawnPs = async (script, env, timeoutMs) => {
    calls.push({ script, env, timeoutMs })
    if (result instanceof Error) throw result
    return result
  }
  return { spawnPs, calls }
}

describe('WindowsDialogApprover', () => {
  it('YES -> true', async () => {
    const f = fake({ code: 0, stdout: 'YES\r\n' })
    expect(await new WindowsDialogApprover({ spawnPs: f.spawnPs }).ask('t', ['a'])).toBe(true)
  })
  it('NO -> false', async () => {
    const f = fake({ code: 0, stdout: 'NO' })
    expect(await new WindowsDialogApprover({ spawnPs: f.spawnPs }).ask('t', ['a'])).toBe(false)
  })
  it('lowercase yes, empty or non-zero stdout -> false', async () => {
    for (const stdout of ['yes', '', 'YESX']) {
      const f = fake({ code: 0, stdout })
      expect(await new WindowsDialogApprover({ spawnPs: f.spawnPs }).ask('t', ['a'])).toBe(false)
    }
  })
  it('timeout/rejection -> false, default timeout 120000', async () => {
    const f = fake(new Error('timeout'))
    expect(await new WindowsDialogApprover({ spawnPs: f.spawnPs }).ask('t', ['a'])).toBe(false)
    expect(f.calls[0].timeoutMs).toBe(120000)
  })
  it('custom timeout is passed through', async () => {
    const f = fake({ code: 0, stdout: 'NO' })
    await new WindowsDialogApprover({ spawnPs: f.spawnPs, timeoutMs: 5 }).ask('t', [])
    expect(f.calls[0].timeoutMs).toBe(5)
  })
  it('never interpolates AI text into the script', async () => {
    const f = fake({ code: 0, stdout: 'NO' })
    const a = new WindowsDialogApprover({ spawnPs: f.spawnPs })
    await a.ask('title', ['safe'])
    const evil = '"; Remove-Item C:\ ; "'
    await a.ask('ti"; calc; "tle', ['x', evil])
    expect(f.calls[1].script).toBe(f.calls[0].script)
    expect(f.calls[1].script).not.toContain('Remove-Item')
    expect(f.calls[1].env.UCS_BODY).toBe(`x\n${evil}`)
    expect(f.calls[1].env.UCS_TITLE).toBe('ti"; calc; "tle')
  })
})
