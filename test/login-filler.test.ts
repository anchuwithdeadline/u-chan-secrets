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

async function run(path: string, password = 'pw') {
  const ctx: BrowserContext = await browser.newContext()
  const page = await ctx.newPage()
  const getCreds = vi.fn(async () => ({ username: 'u@x', password }))
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
  it('reports already logged in without fetching creds', async () => {
    const r = await run('/already')
    expect(r.outcome.status).toBe('already_logged_in')
    expect(r.getCreds).not.toHaveBeenCalled()
  })
  it('refuses redirect to foreign host', async () => {
    fx.posts.length = 0
    const r = await run('/redirect-evil')
    expect(r.outcome).toEqual({ status: 'failed', reason: 'unexpected host localhost' })
    expect(r.getCreds).not.toHaveBeenCalled()
    expect(fx.posts).toHaveLength(0)
  })
})
