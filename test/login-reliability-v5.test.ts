import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { waitForLoginSuccess } from '../src/core/login-success.js'
import { IsolatedLogin } from '../src/service/isolated-login.js'
import { fillLogin } from '../src/core/login-filler.js'
import { restrictPrivateNetwork } from '../src/service/private-network.js'
import { startFixture, type Fixture } from './fixtures/server.js'
let browser: Browser, fx: Fixture
beforeAll(async () => { browser = await chromium.launch(); fx = await startFixture() })
afterAll(async () => { await browser.close(); await fx.close() })
const check = (url: string) => new URL(url).hostname === '127.0.0.1'
it('does not echo a rejected destination hostname that could contain reflected secrets', async () => {
  const fakePage = { goto: async () => {}, url: () => 'https://NO_LOG_SECRET.invalid/login' }
  const result = await fillLogin(fakePage as any, { domain: 'a.test', hosts: ['a.test'], loginUrl: 'https://a.test/login', item: 'dummy' }, vi.fn(), { hostCheck: () => false })
  expect(JSON.stringify(result)).not.toContain('no_log_secret')
  expect(result).toMatchObject({ status: 'failed', code: 'unsupported_form' })
})
it('waits for delayed evidence and refuses absence or an unapproved host', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`http://127.0.0.1:${fx.port}/`)
    await page.evaluate(() => { setTimeout(() => { const node = document.createElement('h1'); node.id = 'verified'; node.textContent = 'Signed in'; document.body.append(node) }, 150) })
    expect(await waitForLoginSuccess(page, { selector: '#verified' }, check, undefined, 1000)).toBe(true)
    expect(await waitForLoginSuccess(page, { selector: '#absent' }, check, undefined, 100)).toBe(false)
    expect(await waitForLoginSuccess(page, { selector: '#verified' }, () => false, undefined, 100)).toBe(false)
  } finally { await page.close() }
})
it('blocks a cross-host password form action before dummy credentials reach that host', async () => {
  const target = { userAgent: async () => 'test', inject: vi.fn(async () => {}) }
  const runner = new IsolatedLogin({ launch: async () => browser, target, hostCheck: check, timeoutMs: 300 })
  const before = fx.posts.length
  const result = await runner.run({ domain: '127.0.0.1', hosts: ['127.0.0.1'], loginUrl: `http://127.0.0.1:${fx.port}/off-host-action`, item: 'dummy' }, async () => ({ username: 'u@x', password: 'pw' }))
  expect(result).toMatchObject({ status: 'failed', code: 'unsupported_form' })
  expect(fx.posts.slice(before)).not.toContain('/single')
  expect(target.inject).not.toHaveBeenCalled()
})
it('does not claim login when private success fails verification in the destination browser', async () => {
  const verify = vi.fn(async () => false), inject = vi.fn(async () => {})
  const target = { userAgent: async () => 'test', inject, verify }
  const runner = new IsolatedLogin({ launch: async () => browser, target, hostCheck: check, timeoutMs: 1000 })
  const result = await runner.run({ domain: '127.0.0.1', hosts: ['127.0.0.1'], loginUrl: `http://127.0.0.1:${fx.port}/single`, item: 'dummy', success: { selector: 'h1' } }, async () => ({ username: 'u@x', password: 'pw' }))
  expect(result).toMatchObject({ status: 'unconfirmed', code: 'destination_unconfirmed' })
  expect(verify).toHaveBeenCalledOnce()
  expect(inject).toHaveBeenCalledOnce()
})
it('never confirms success for a destination without a verifier', async () => {
  const target = { userAgent: async () => 'test', inject: vi.fn(async () => {}) }
  const runner = new IsolatedLogin({ launch: async () => browser, target, hostCheck: check, timeoutMs: 1000 })
  expect(await runner.run({ domain: '127.0.0.1', hosts: ['127.0.0.1'], loginUrl: `http://127.0.0.1:${fx.port}/single`, item: 'dummy', success: { selector: 'h1' } }, async () => ({ username: 'u@x', password: 'pw' })))
    .toMatchObject({ status: 'unconfirmed', code: 'destination_unconfirmed' })
})
it('reports possible partial state on cancellation during injection or destination verification', async () => {
  for (const stage of ['inject','verify']) {
    const controller = new AbortController(), inject = vi.fn(async () => { if (stage === 'inject') controller.abort() })
    const target = { userAgent: async () => 'test', inject, verify: async () => { controller.abort(); return false } }
    const runner = new IsolatedLogin({ launch: async () => browser, target, hostCheck: check, timeoutMs: 1000 })
    const result = await runner.run({ domain: '127.0.0.1', hosts: ['127.0.0.1'], loginUrl: `http://127.0.0.1:${fx.port}/single`, item: 'dummy', success: { selector: 'h1' } }, async () => ({ username: 'u@x', password: 'pw' }), { signal: controller.signal })
    expect(result).toMatchObject({ status: 'failed', code: 'login_timeout' })
    expect(result.reason).toContain('browser session state may already exist')
    expect(inject).toHaveBeenCalledOnce()
  }
})
it('blocks off-host fetch, frames, images, redirects and WebSockets without a network canary hit', async () => {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const blocked = await restrictPrivateNetwork(context, check, AbortSignal.timeout(10000))
  try {
    const page = await context.newPage(), before = fx.canaryHits
    await page.goto(`http://127.0.0.1:${fx.port}/`)
    await page.evaluate(async port => {
      const outside = `http://localhost:${port}/off-host-canary`
      await fetch(outside).catch(() => {})
      for (const kind of ['img','iframe']) { const element = document.createElement(kind); element.setAttribute('src', outside); document.body.append(element) }
      await new Promise<void>(resolve => { const socket = new WebSocket(`ws://localhost:${port}/off-host-canary`); socket.onclose = () => resolve(); socket.onerror = () => resolve(); setTimeout(() => resolve(), 300) })
    }, fx.port)
    await page.goto(`http://127.0.0.1:${fx.port}/redirect-evil`).catch(() => {})
    expect(blocked()).toBe(true)
    expect(fx.canaryHits).toBe(before)
  } finally { await context.close() }
})
