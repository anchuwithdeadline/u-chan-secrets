import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { IsolatedLogin } from '../src/service/isolated-login.js'
import { startFixture, type Fixture } from './fixtures/server.js'
let browser: Browser, fx: Fixture
beforeAll(async () => { browser = await chromium.launch(); fx = await startFixture() })
afterAll(async () => { await browser.close(); await fx.close() })
const creds = async () => ({ username: 'u@x', password: 'pw' })
function setup(path = '/single') {
  const inject = vi.fn(async () => {})
  const runner = new IsolatedLogin({ launch: async () => browser, target: { userAgent: async () => 'test', inject, verify: async () => true }, timeoutMs: 3000, hostCheck: url => new URL(url).hostname === '127.0.0.1' })
  const entry = { domain: '127.0.0.1', hosts: ['127.0.0.1'], item: 'test', loginUrl: `http://127.0.0.1:${fx.port}${path}` }
  return { runner, inject, entry }
}
it('transfers legacy heuristic state while reporting unconfirmed authentication', async () => {
  const { runner, inject, entry } = setup()
  const result = await runner.run(entry, creds)
  expect(result).toMatchObject({ status: 'unconfirmed', code: 'authentication_unconfirmed' })
  expect(inject).toHaveBeenCalledOnce()
})
it('does not confirm authentication merely because a blank page lacks login fields', async () => {
  const { runner, entry } = setup('/')
  expect(await runner.run(entry, creds)).toMatchObject({ status: 'unconfirmed' })
})
it('requires an approved success condition and aborts transfer when it fails', async () => {
  const { runner, inject, entry } = setup()
  expect(await runner.run({ ...entry, success: { selector: '#missing' } }, creds)).toMatchObject({ status: 'failed', code: 'success_condition_failed' })
  expect(inject).not.toHaveBeenCalled()
  expect(await runner.run({ ...entry, success: { selector: 'h1' } }, creds)).toEqual({ status: 'logged_in' })
  expect(inject).toHaveBeenCalledOnce()
})
it('rechecks service authorization before exporting and injecting session state', async () => {
  const { runner, inject, entry } = setup()
  let checks = 0
  await expect((runner.run as any)({ ...entry, success: { selector: 'h1' } }, creds, {
    beforeTransfer: async () => { if (++checks === 2) throw new Error('expired') },
  })).rejects.toThrow('expired')
  expect(inject).not.toHaveBeenCalled()
})
it('cancels the isolated context and never injects when the service aborts', async () => {
  const { runner, inject, entry } = setup()
  const controller = new AbortController()
  const out = await runner.run(entry, async () => { controller.abort(); return creds() }, { signal: controller.signal })
  expect(out).toMatchObject({ status: 'failed', code: 'login_timeout' })
  expect(inject).not.toHaveBeenCalled()
  expect(browser.contexts()).toHaveLength(0)
})
it('does not confirm a selector after navigation to an unapproved host during form detection', async () => {
  const { runner, inject, entry } = setup('/nav-no-fields')
  expect((await runner.run({ ...entry, success: { selector: 'h1' } }, creds)).status).toBe('failed')
  expect(inject).not.toHaveBeenCalled()
})
it('aborts pending context creation and closes the owned browser before returning', async () => {
  const controller = new AbortController()
  let closed = false
  const runner = new IsolatedLogin({
    launch: async () => ({
      isConnected: () => true,
      newContext: async () => { controller.abort(); return new Promise(() => {}) },
      close: async () => { closed = true },
    }) as any,
    target: { userAgent: async () => 'test', inject: async () => {} },
  })
  const result = await Promise.race([runner.run({ domain: 'a.com', hosts: ['a.com'], loginUrl: 'https://a.com/login', item: 'A' }, creds, { signal: controller.signal }), new Promise(resolve => setTimeout(() => resolve('pending'), 200))])
  expect(result).toMatchObject({ status: 'failed', code: 'login_timeout' })
  expect(closed).toBe(true)
})
