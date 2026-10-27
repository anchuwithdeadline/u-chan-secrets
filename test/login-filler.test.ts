import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser, type BrowserContext } from 'playwright'
import { fillLogin } from '../src/core/login-filler.js'
import type { AllowEntry } from '../src/core/types.js'
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

const entry = (path: string): AllowEntry => ({
  domain: '127.0.0.1', hosts: ['127.0.0.1'], loginUrl: `http://127.0.0.1:${fx.port}${path}`, item: 'x',
})
const hostCheck = (url: string) => new URL(url).hostname === '127.0.0.1'

async function run(path: string, password = 'pw', username = 'u@x') {
  const ctx: BrowserContext = await browser.newContext()
  const page = await ctx.newPage()
  const getCreds = vi.fn(async () => ({ username, password }))
  try {
    const outcome = await fillLogin(page, entry(path), getCreds, { timeoutMs: 3000, hostCheck })
    return { outcome, getCreds, url: page.url() }
  } finally {
    await ctx.close()
  }
}

describe('fillLogin', () => {
  it('logs in on single-step form', async () => {
    const r = await run('/single')
    expect(r.outcome).toEqual({ status: 'logged_in' })
    expect(r.url).toMatch(/\/dash$/)
    expect(r.getCreds).toHaveBeenCalledTimes(1)
  })
  it('waits for an SPA form that hides after the URL changes', async () => {
    const r = await run('/spa-slow')
    expect(r.outcome).toEqual({ status: 'logged_in' })
    expect(r.url).toMatch(/\/dash$/)
  })
  it('waits for an SPA that re-renders the form before navigating', async () => {
    const r = await run('/spa-remount')
    expect(r.outcome).toEqual({ status: 'logged_in' })
    expect(r.url).toMatch(/\/dash$/)
  })
  it('fails on wrong password without leaking it', async () => {
    const r = await run('/single', 'wrong-secret-123')
    expect(r.outcome.status).toBe('failed')
    expect(r.outcome.reason).toContain('login form still present')
    expect(JSON.stringify(r.outcome)).not.toContain('wrong-secret-123')
  })
  it('handles two-step form', async () => {
    expect((await run('/two-step')).outcome.status).toBe('logged_in')
  })
  it('fails two-step wrong password', async () => {
    expect((await run('/two-step', 'bad-pw-xyz')).outcome.status).toBe('failed')
  })
  it('reports already logged in without fetching creds', async () => {
    const r = await run('/already')
    expect(r.outcome.status).toBe('already_logged_in')
    expect(r.getCreds).not.toHaveBeenCalled()
  })
  it('waits for late-rendered forms', async () => {
    expect((await run('/late')).outcome.status).toBe('logged_in')
  })
  it('refuses redirect to foreign host', async () => {
    fx.posts.length = 0
    const r = await run('/redirect-evil')
    expect(r.outcome).toEqual({ status: 'failed', reason: 'unexpected host localhost' })
    expect(r.getCreds).not.toHaveBeenCalled()
    expect(fx.posts).toHaveLength(0)
  })
  it('reports username field not found', async () => {
    expect((await run('/pass-only')).outcome).toEqual({ status: 'failed', reason: 'username field not found' })
  })
  it('reports password field did not appear', async () => {
    expect((await run('/stuck')).outcome).toEqual({ status: 'failed', reason: 'password field did not appear' })
  })
  it('does not leak credentials in thrown errors', async () => {
    const err = await run('/disabled-pass', 'sekret-pw-777', 'secret-user@x').then(() => undefined, (e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toBe('failed to fill password field')
    expect(String(err!.stack)).not.toContain('sekret-pw-777')
    expect(String(err!.stack)).not.toContain('secret-user@x')
    expect((err as { cause?: unknown }).cause).toBeUndefined()
  })
  it('never delivers credentials to a page that navigated to another host', async () => {
    fx.posts.length = 0
    const ctx = await browser.newContext()
    const page = await ctx.newPage()
    const bodies: string[] = []
    page.on('request', (r) => { if (r.method() === 'POST') bodies.push(r.postData() ?? '') })
    let text = ''
    try {
      const out = await fillLogin(page, entry('/nav-evil'), async () => ({ username: 'u@x', password: 'nav-pw-555' }), { timeoutMs: 3000, hostCheck })
      text = JSON.stringify(out)
      expect(out.status).toBe('failed')
    } catch (e) {
      text = String((e as Error).message)
    } finally {
      await ctx.close()
    }
    expect(text).not.toContain('nav-pw-555')
    expect(fx.posts).toHaveLength(0)
    expect(bodies.join('')).not.toContain('nav-pw-555')
  })
})
