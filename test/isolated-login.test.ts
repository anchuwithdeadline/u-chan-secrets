import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { IsolatedLogin } from '../src/service/isolated-login.js'
import type { SessionState } from '../src/service/session-transfer.js'
import type { AllowEntry, SessionTarget } from '../src/core/types.js'
import { startFixture, type Fixture } from './fixtures/server.js'

let browser: Browser
let fx: Fixture
beforeAll(async () => {
  browser = await chromium.launch()
  fx = await startFixture()
})
afterAll(async () => {
  await browser.close()
  await fx.close()
})

const entry = (): AllowEntry => ({
  success: { selector: 'h1' },
  domain: '127.0.0.1', hosts: ['127.0.0.1'], loginUrl: `http://127.0.0.1:${fx.port}/single`, item: 'x',
})
const hostCheck = (url: string) => new URL(url).hostname === '127.0.0.1'
const creds = async () => ({ username: 'u@x', password: 'pw' })
const mkTarget = (inject = vi.fn(async (_s: SessionState) => {})): SessionTarget & { inject: typeof inject } => ({
  userAgent: async () => 'UCS-Test-Agent/1.0',
  inject,
  verify: vi.fn(async () => true), // Unit destination supplies explicit evidence; real transfer is covered in browser.test.ts.
})

describe('IsolatedLogin', () => {
  it('isolated-login: hands over the session', async () => {
    const target = mkTarget()
    const closes: string[] = []
    const launch = async () => {
      const orig = browser.newContext.bind(browser)
      return Object.assign(Object.create(browser), {
        newContext: async (o: Parameters<Browser['newContext']>[0]) => {
          const ctx = await orig(o)
          ctx.on('close', () => closes.push('closed'))
          return ctx
        },
      }) as Browser
    }
    const r = await new IsolatedLogin({ launch, target, timeoutMs: 5000, hostCheck }).run(entry(), creds)
    expect(r).toEqual({ status: 'logged_in' })
    expect(target.inject).toHaveBeenCalledTimes(1)
    const state = target.inject.mock.calls[0]![0] as { cookies: { name: string }[] }
    expect(state.cookies.some((c) => c.name === 'sid')).toBe(true)
    expect(closes).toEqual(['closed'])
  }, 30000)

  it('isolated-login: fresh context each run', async () => {
    const target = mkTarget()
    const spy = vi.spyOn(browser, 'newContext')
    const login = new IsolatedLogin({ launch: async () => browser, target, timeoutMs: 5000, hostCheck })
    expect(await login.run(entry(), creds)).toEqual({ status: 'logged_in' })
    expect(await login.run(entry(), creds)).toEqual({ status: 'logged_in' })
    expect(spy).toHaveBeenCalledTimes(2)
    expect(spy.mock.calls[0]![0]).toMatchObject({ userAgent: 'UCS-Test-Agent/1.0' })
    spy.mockRestore()
  }, 30000)

  it('isolated-login: inject failure', async () => {
    const target = mkTarget(vi.fn(async (_s: SessionState) => { throw new Error('secret-detail') }))
    const r = await new IsolatedLogin({ launch: async () => browser, target, timeoutMs: 5000, hostCheck }).run(entry(), creds)
    expect(r).toEqual({ status: 'failed', reason: 'session transfer did not complete; some browser session state may already exist', code: 'session_transfer_failed' })
  }, 30000)
})
