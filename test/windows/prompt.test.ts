import { describe, expect, it, vi } from 'vitest'
import {
  WindowsProtectedPrompt,
  type PromptRunner,
  type PromptRunnerOutcome,
  type PromptExecFile,
} from '../../src/platform/windows/prompt.js'
import type { PromptRequest } from '../../src/core/types.js'

describe('WindowsProtectedPrompt', () => {
  const sampleReq: PromptRequest = {
    title: 'Unlock Vault',
    lines: ['Domain: example.com', 'Action: autofill'],
    phrase: 'anti-phish-req',
  }

  describe('confirm', () => {
    it('returns true on approval', async () => {
      const runner: PromptRunner = vi.fn(async () => ({ ok: true }))
      const prompt = new WindowsProtectedPrompt({ phrase: 'my-secret-phrase', runner })

      const result = await prompt.confirm(sampleReq)

      expect(result).toBe(true)
      expect(runner).toHaveBeenCalledWith({
        mode: 'confirm',
        title: 'Unlock Vault',
        lines: ['Domain: example.com', 'Action: autofill'],
        phrase: 'my-secret-phrase',
        timeoutMs: 120000,
      })
    })

    it('returns false on cancel or window close', async () => {
      const runner: PromptRunner = vi.fn(async () => ({ ok: false }))
      const prompt = new WindowsProtectedPrompt({ phrase: 'my-secret-phrase', runner })

      const result = await prompt.confirm(sampleReq)

      expect(result).toBe(false)
    })

    it('returns false when runner rejects without throwing', async () => {
      const runner: PromptRunner = vi.fn(async () => {
        throw new Error('Process spawn failed')
      })
      const prompt = new WindowsProtectedPrompt({ phrase: 'my-secret-phrase', runner })

      const result = await prompt.confirm(sampleReq)

      expect(result).toBe(false)
    })
  })

  describe('askPassword', () => {
    it('returns trimmed password on approval', async () => {
      const runner: PromptRunner = vi.fn(async () => ({
        ok: true,
        password: '  mypassword123 \r\n',
      }))
      const prompt = new WindowsProtectedPrompt({ phrase: 'phrase-xyz', runner })

      const result = await prompt.askPassword(sampleReq)

      expect(result).toBe('mypassword123')
      expect(runner).toHaveBeenCalledWith({
        mode: 'password',
        title: 'Unlock Vault',
        lines: ['Domain: example.com', 'Action: autofill'],
        phrase: 'phrase-xyz',
        timeoutMs: 120000,
      })
    })

    it('returns null on cancel or window close', async () => {
      const runner: PromptRunner = vi.fn(async () => ({ ok: false }))
      const prompt = new WindowsProtectedPrompt({ phrase: 'phrase-xyz', runner })

      const result = await prompt.askPassword(sampleReq)

      expect(result).toBeNull()
    })

    it('returns null when ok is true but password is missing', async () => {
      const runner: PromptRunner = vi.fn(async () => ({ ok: true }))
      const prompt = new WindowsProtectedPrompt({ phrase: 'phrase-xyz', runner })

      const result = await prompt.askPassword(sampleReq)

      expect(result).toBeNull()
    })

    it('returns null when runner rejects', async () => {
      const runner: PromptRunner = vi.fn(async () => {
        throw new Error('hardware window timeout')
      })
      const prompt = new WindowsProtectedPrompt({ phrase: 'phrase-xyz', runner })

      const result = await prompt.askPassword(sampleReq)

      expect(result).toBeNull()
    })
  })

  describe('configuration & anti-phishing phrase', () => {
    it('passes phrase from options over req.phrase', async () => {
      let capturedPhrase = ''
      const runner: PromptRunner = async (params) => {
        capturedPhrase = params.phrase
        return { ok: true }
      }
      const prompt = new WindowsProtectedPrompt({ phrase: 'configured-phrase', runner })

      await prompt.confirm({ title: 'T', lines: [], phrase: 'req-phrase' })
      expect(capturedPhrase).toBe('configured-phrase')
    })

    it('falls back to req.phrase if options.phrase is empty', async () => {
      let capturedPhrase = ''
      const runner: PromptRunner = async (params) => {
        capturedPhrase = params.phrase
        return { ok: true }
      }
      const prompt = new WindowsProtectedPrompt({ phrase: '', runner })

      await prompt.confirm({ title: 'T', lines: [], phrase: 'req-phrase' })
      expect(capturedPhrase).toBe('req-phrase')
    })

    it('uses custom timeoutMs if specified in options', async () => {
      let capturedTimeout = 0
      const runner: PromptRunner = async (params) => {
        capturedTimeout = params.timeoutMs
        return { ok: true }
      }
      const prompt = new WindowsProtectedPrompt({
        phrase: 'phrase',
        timeoutMs: 5000,
        runner,
      })

      await prompt.confirm(sampleReq)
      expect(capturedTimeout).toBe(5000)
    })
  })

  describe('serialization', () => {
    it('serializes prompt invocations so second call waits for first to finish', async () => {
      const callLog: string[] = []

      let resolveFirst!: (value: PromptRunnerOutcome) => void
      const firstPromise = new Promise<PromptRunnerOutcome>((res) => {
        resolveFirst = res
      })

      const runner: PromptRunner = vi.fn(async (params) => {
        callLog.push(`start:${params.title}`)
        if (params.title === 'First') {
          return await firstPromise
        }
        return { ok: true }
      })

      const prompt = new WindowsProtectedPrompt({ phrase: 'phrase', runner })

      const p1 = prompt.confirm({ title: 'First', lines: [], phrase: '' })
      const p2 = prompt.confirm({ title: 'Second', lines: [], phrase: '' })

      // First call has started, second has not started yet
      await new Promise((r) => setTimeout(r, 10))
      expect(callLog).toEqual(['start:First'])

      // Resolve first
      resolveFirst({ ok: true })
      const [res1, res2] = await Promise.all([p1, p2])

      expect(res1).toBe(true)
      expect(res2).toBe(true)
      expect(callLog).toEqual(['start:First', 'start:Second'])
    })

    it('continues queue even if previous prompt runner rejects', async () => {
      let callCount = 0
      const runner: PromptRunner = vi.fn(async () => {
        callCount++
        if (callCount === 1) {
          throw new Error('first failed')
        }
        return { ok: true }
      })

      const prompt = new WindowsProtectedPrompt({ phrase: 'phrase', runner })

      const res1 = await prompt.confirm({ title: 'First', lines: [], phrase: '' })
      const res2 = await prompt.confirm({ title: 'Second', lines: [], phrase: '' })

      expect(res1).toBe(false)
      expect(res2).toBe(true)
      expect(callCount).toBe(2)
    })
  })

  describe('default runner (child_process.execFile)', () => {
    it('executes promptExePath with expected CLI args and timeout', async () => {
      const fakeExecFile: PromptExecFile = vi.fn((file, args, options, callback) => {
        callback(null, 'user-secret-pw\n', '')
      })

      const prompt = new WindowsProtectedPrompt({
        phrase: 'anti-phish',
        promptExePath: 'C:\\bin\\prompt.exe',
        timeoutMs: 30000,
        execFile: fakeExecFile,
      })

      const pw = await prompt.askPassword({
        title: 'Enter Password',
        lines: ['Line 1', 'Line 2'],
        phrase: 'unused',
      })

      expect(pw).toBe('user-secret-pw')
      expect(fakeExecFile).toHaveBeenCalledWith(
        'C:\\bin\\prompt.exe',
        [
          '--mode',
          'password',
          '--title',
          'Enter Password',
          '--phrase',
          'anti-phish',
          '--lines',
          JSON.stringify(['Line 1', 'Line 2']),
        ],
        expect.objectContaining({ timeout: 30000 }),
        expect.any(Function)
      )
    })

    it('returns false/null when execFile returns non-zero code or error', async () => {
      const fakeExecFile: PromptExecFile = vi.fn((_file, _args, _options, callback) => {
        const err = new Error('Command failed: exit code 1')
        Object.assign(err, { code: 1 })
        callback(err, '', 'Cancelled')
      })

      const prompt = new WindowsProtectedPrompt({
        phrase: 'phrase',
        promptExePath: 'C:\\bin\\prompt.exe',
        execFile: fakeExecFile,
      })

      const confirmRes = await prompt.confirm(sampleReq)
      const passwordRes = await prompt.askPassword(sampleReq)

      expect(confirmRes).toBe(false)
      expect(passwordRes).toBeNull()
    })

    it('returns false/null when promptExePath is missing', async () => {
      const prompt = new WindowsProtectedPrompt({ phrase: 'phrase' })
      expect(await prompt.confirm(sampleReq)).toBe(false)
      expect(await prompt.askPassword(sampleReq)).toBeNull()
    })

    it('returns false/null when execFile throws synchronously', async () => {
      const fakeExecFile: PromptExecFile = vi.fn(() => {
        throw new Error('EACCES: permission denied')
      })

      const prompt = new WindowsProtectedPrompt({
        phrase: 'phrase',
        promptExePath: 'C:\\bin\\prompt.exe',
        execFile: fakeExecFile,
      })

      expect(await prompt.confirm(sampleReq)).toBe(false)
      expect(await prompt.askPassword(sampleReq)).toBeNull()
    })
  })
})
