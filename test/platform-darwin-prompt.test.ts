import { describe, it, expect, vi } from 'vitest'
import { buildJxaPromptScript } from '../src/platform/darwin/prompt-script.js'
import { MacosProtectedPrompt } from '../src/platform/darwin/prompt.js'
import { UserFacingError } from '../src/core/types.js'
import { platformAdapters } from '../src/platform/index.js'

describe('macOS protected prompt', () => {
  const req = {
    title: 'U-Chan Approval',
    lines: ['Domain: github.com', 'Item: GitHub Personal'],
    phrase: 'crystal mountain owl',
  }

  it('builds JXA script with title, phrase, and lines', () => {
    const script = buildJxaPromptScript(req)
    expect(script).toContain('$.NSAlert')
    expect(script).toContain('$.NSSecureTextField')
    expect(script).toContain('U-Chan Approval')
    expect(script).toContain('crystal mountain owl')
    expect(script).toContain('github.com')
  })

  it('safely escapes special characters in JXA script', () => {
    const dangerousReq = {
      title: 'Title with "quotes" and \\backslashes\\ and \nnewlines',
      lines: ['Line "1" with `backticks`', 'Line \\2\\'],
      phrase: 'phrase "with" quotes',
    }
    const script = buildJxaPromptScript(dangerousReq)
    expect(script).toContain('$.NSAlert')
    expect(script).toContain('phrase \\"with\\" quotes')
  })

  it('askPassword invokes launchctl asuser with 2-minute timeout', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'my-master-password\n', exitCode: 0 })
    const prompt = new MacosProtectedPrompt({ installUid: 501, executor: { exec } })

    const pw = await prompt.askPassword(req)
    expect(pw).toBe('my-master-password')
    expect(exec).toHaveBeenCalledWith(
      '/bin/launchctl',
      ['asuser', '501', '/usr/bin/osascript', '-l', 'JavaScript', '-e', expect.stringContaining('$.NSAlert')],
      120000,
    )
  })

  it('returns null on cancel, window close, or 2-minute timeout', async () => {
    const execCancel = vi.fn().mockResolvedValue({ stdout: '', exitCode: 1 })
    const promptCancel = new MacosProtectedPrompt({ installUid: 501, executor: { exec: execCancel } })
    expect(await promptCancel.askPassword(req)).toBeNull()

    const execTimeout = vi.fn().mockRejectedValue(new Error('timeout'))
    const promptTimeout = new MacosProtectedPrompt({ installUid: 501, executor: { exec: execTimeout } })
    expect(await promptTimeout.askPassword(req)).toBeNull()
  })

  it('confirm throws UserFacingError because easy mode is disabled on macOS', async () => {
    const prompt = new MacosProtectedPrompt({ installUid: 501 })
    await expect(prompt.confirm(req)).rejects.toThrow(UserFacingError)
    await expect(prompt.confirm(req)).rejects.toThrow(/easy mode is disabled on macOS/)
  })

  it('wires MacosProtectedPrompt into platformAdapters for darwin', async () => {
    const exec = vi.fn().mockResolvedValue({ stdout: 'pass123\n', exitCode: 0 })
    const adapters = platformAdapters('darwin', {
      installUid: 501,
      execPrompt: exec,
    })
    expect(adapters.prompt).toBeInstanceOf(MacosProtectedPrompt)
    const pw = await adapters.prompt.askPassword(req)
    expect(pw).toBe('pass123')
  })
})
