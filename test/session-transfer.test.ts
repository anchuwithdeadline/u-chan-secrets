import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { filterState, type SessionState } from '../src/service/session-transfer.js'
import { CdpBrowserProvider, CdpSessionTarget } from '../src/core/browser.js'
import { startFixture, type Fixture } from './fixtures/server.js'

const cookie = (domain: string, name = 'c') => ({
  name, value: 'v', domain, path: '/', expires: -1, httpOnly: false, secure: false, sameSite: 'Lax' as const,
})

describe('filterState', () => {
  it('keeps only entry hosts', () => {
    const state: SessionState = {
      cookies: [cookie('example.com', 'a'), cookie('.example.com', 'b'), cookie('evil.com', 'c'), cookie('a.example.com', 'd')],
      origins: [
        { origin: 'https://example.com', localStorage: [{ name: 'k', value: 'v' }] },
        { origin: 'https://evil.com', localStorage: [{ name: 'k', value: 'v' }] },
      ],
    }
    const out = filterState(state, ['example.com'])
    expect(out.cookies.map((c) => c.name)).toEqual(['a', 'b'])
    expect(out.origins.map((o) => o.origin)).toEqual(['https://example.com'])
  })
})

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

describe('CdpSessionTarget', () => {
  let chrome: Browser
  let fx: Fixture
  let port: number
  beforeAll(async () => {
    port = await freePort()
    chrome = await chromium.launch({ args: [`--remote-debugging-port=${port}`] })
    fx = await startFixture()
  })
  afterAll(async () => {
    await chrome.close()
    await fx.close()
  })

  it('CdpSessionTarget injects cookies', async () => {
    const provider = new CdpBrowserProvider(`http://127.0.0.1:${port}`)
    const target = new CdpSessionTarget(provider)
    expect(await target.userAgent()).toMatch(/Mozilla/)
    await target.inject({
      cookies: [{ ...cookie('127.0.0.1', 'injected'), value: 'yes' }],
      origins: [{ origin: `http://127.0.0.1:${fx.port}`, localStorage: [{ name: 'tok', value: 'abc' }] }],
    })
    const other = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const ctx = other.contexts()[0]!
    expect((await ctx.cookies()).some((c) => c.name === 'injected' && c.value === 'yes')).toBe(true)
    const page = await ctx.newPage()
    await page.goto(`http://127.0.0.1:${fx.port}/dash`)
    expect(await page.evaluate(() => localStorage.getItem('tok'))).toBe('abc')
    await page.close()
  }, 30000)

  it('rejects when the origin redirects elsewhere and writes nothing there', async () => {
    const provider = new CdpBrowserProvider(`http://127.0.0.1:${port}`)
    const target = new CdpSessionTarget(provider)
    fx.bounceRoot = true
    const foreignBefore = fx.foreignHostHits
    await expect(
      target.inject({
        cookies: [],
        origins: [{ origin: `http://127.0.0.1:${fx.port}`, localStorage: [{ name: 'leak', value: 'x' }] }],
      }),
    ).rejects.toThrow()
    expect(fx.foreignHostHits).toBe(foreignBefore)
    const other = await chromium.connectOverCDP(`http://127.0.0.1:${port}`)
    const page = await other.contexts()[0]!.newPage()
    await page.goto(`http://localhost:${fx.port}/dash`)
    expect(await page.evaluate(() => localStorage.getItem('leak'))).toBeNull()
    await page.close()
  }, 30000)
})
