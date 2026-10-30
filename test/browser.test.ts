import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { CdpBrowserProvider, CdpSessionTarget } from '../src/core/browser.js'
import { IsolatedLogin } from '../src/service/isolated-login.js'
import { UserFacingError } from '../src/core/types.js'
import { startFixture, type Fixture } from './fixtures/server.js'

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address() as { port: number }
      s.close(() => resolve(port))
    })
  })

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

describe('CdpBrowserProvider', () => {
  it('cancels stalled CDP evaluation without closing the shared Chrome process', async () => {
    const provider = new CdpBrowserProvider(`http://127.0.0.1:${port}`)
    const controller = new AbortController()
    const operation = provider.withPage(async page => {
      const timer = setTimeout(() => controller.abort(), 50)
      try { return await page.evaluate(() => new Promise(() => {})) }
      finally { clearTimeout(timer) }
    }, controller.signal)
    await expect(operation).rejects.toThrow()
    expect(chrome.isConnected()).toBe(true)
    const context = await chrome.newContext()
    await context.close()
  })
  it('closes owned tabs on cancellation before dropping CDP while preserving original tabs', async () => {
    const connection = await chromium.connectOverCDP(`http://127.0.0.1:${port}`), context = connection.contexts()[0]
    const existing = await context.newPage(), before = new Set(context.pages()), provider = new CdpBrowserProvider(`http://127.0.0.1:${port}`)
    try {
      const controller = new AbortController()
      await expect(provider.withPage(async () => { setTimeout(() => controller.abort(), 50); return new Promise(() => {}) }, controller.signal)).rejects.toThrow()
      expect(new Set(context.pages())).toEqual(before)
      expect(existing.isClosed()).toBe(false)
    } finally { await existing.close(); await provider.disconnect(); await connection.close() }
  })
  it('closes a page whose creation finishes after cancellation', async () => {
    const endpoint=`http://127.0.0.1:${port}`, connection=await chromium.connectOverCDP(endpoint), observer=await chromium.connectOverCDP(endpoint)
    const context=connection.contexts()[0], before=observer.contexts()[0].pages().length, controller=new AbortController(), original=context.newPage.bind(context)
    const connectSpy=vi.spyOn(chromium,'connectOverCDP').mockResolvedValue(connection)
    const pageSpy=vi.spyOn(context,'newPage').mockImplementation(async()=>{const page=await original();controller.abort();await new Promise(resolve=>setTimeout(resolve,50));return page})
    const provider=new CdpBrowserProvider(endpoint)
    try {
      await expect(provider.withPage(async()=> 'must not run',controller.signal)).rejects.toThrow()
      expect(observer.contexts()[0].pages()).toHaveLength(before)
    } finally {pageSpy.mockRestore();connectSpy.mockRestore();await provider.disconnect();await connection.close();await observer.close()}
  })
  it('blocks all approved-to-approved-to-off-host redirect chains during destination verification', async () => {
    const provider = new CdpBrowserProvider(`http://127.0.0.1:${port}`), target = new CdpSessionTarget(provider, { hostCheck: (_e,url) => new URL(url).hostname === '127.0.0.1', verifyTimeoutMs: 100 })
    try {
      for (const code of [302,303,307,308]) {
        const url=`http://127.0.0.1:${fx.port}/chain-start/${code}`, before=fx.canaryHits
        expect(await target.verify({domain:'127.0.0.1',hosts:['127.0.0.1'],loginUrl:url,item:'dummy',success:{url}},url)).toBe(false)
        expect(fx.canaryHits).toBe(before)
      }
    } finally { await provider.disconnect() }
  })
  it('shares cookies with an independent CDP connection', async () => {
    const endpoint = `http://127.0.0.1:${port}`
    const provider = new CdpBrowserProvider(endpoint)
    expect(await provider.connected()).toBe(true)
    await provider.withPage(async (page) => {
      await page.goto(`http://127.0.0.1:${fx.port}/dash`)
      await page.evaluate(() => { document.cookie = 'ucs=shared; path=/' })
    })
    const other = await chromium.connectOverCDP(endpoint)
    try {
      const cookies = await other.contexts()[0].cookies(`http://127.0.0.1:${fx.port}/`)
      expect(cookies.find((c) => c.name === 'ucs')?.value).toBe('shared')
    } finally {
      await other.close()
    }
  })
  it('launches Chrome itself when CDP is down, then connects', async () => {
    const p2 = await freePort()
    let launched: Browser | undefined
    const provider = new CdpBrowserProvider(`http://127.0.0.1:${p2}`, {
      launch: async () => {
        // simulate start-chrome.ps1: returns before Chrome is listening
        void chromium.launch({ args: [`--remote-debugging-port=${p2}`] }).then((b) => (launched = b))
      },
    })
    try {
      expect(await provider.withPage(async (page) => typeof page.goto)).toBe('function')
    } finally {
      await launched?.close()
    }
  }, 30000)
  it('does not launch Chrome just to report status', async () => {
    let calls = 0
    const p = new CdpBrowserProvider(`http://127.0.0.1:${await freePort()}`, { launch: async () => void calls++ })
    expect(await p.connected()).toBe(false)
    expect(calls).toBe(0)
  })
  it('gives a user-facing error when launch never brings CDP up', async () => {
    const p = new CdpBrowserProvider(`http://127.0.0.1:${await freePort()}`, { launch: async () => {}, launchTimeoutMs: 1000 })
    await expect(p.withPage(async () => 1)).rejects.toThrow(/could not start the selected dedicated browser/)
  })
  it('reports Chrome not running as a user-facing error', async () => {
    const p = new CdpBrowserProvider(`http://127.0.0.1:${await freePort()}`)
    expect(await p.connected()).toBe(false)
    await expect(p.withPage(async () => 1)).rejects.toThrow(UserFacingError)
  })
  it('rechecks configured identity before reusing a connected target and leaves its process alive', async () => {
    let allowed = true
    const provider = new CdpBrowserProvider(`http://127.0.0.1:${port}`, { validate: async () => allowed })
    try {
      expect(await provider.connected()).toBe(true)
      allowed = false
      await expect(provider.withPage(async () => 'must not run')).rejects.toThrow(/identity could not be verified/)
      expect(chrome.isConnected()).toBe(true)
    } finally { await provider.disconnect() }
  })
  it('verifies an authenticated transferred session while preserving existing user tabs and cookies', async () => {
    const endpoint = `http://127.0.0.1:${port}`, provider = new CdpBrowserProvider(endpoint)
    const target = new CdpSessionTarget(provider, { hostCheck: (_entry, url) => new URL(url).hostname === '127.0.0.1', verifyTimeoutMs: 500 })
    const independent = await chromium.connectOverCDP(endpoint), context = independent.contexts()[0]
    const existing = await context.newPage(), privateBrowser = await chromium.launch()
    try {
      await existing.goto(`http://127.0.0.1:${fx.port}/`)
      await context.addCookies([{ name: 'keep-existing', value: 'dummy', url: `http://127.0.0.1:${fx.port}` }])
      const entry = { domain: '127.0.0.1', hosts: ['127.0.0.1'], loginUrl: `http://127.0.0.1:${fx.port}/verified-single`, item: 'dummy', success: { selector: '#account' } }
      expect(await target.verify(entry, `http://127.0.0.1:${fx.port}/protected-dash`)).toBe(false)
      const runner = new IsolatedLogin({ launch: async () => privateBrowser, target, hostCheck: url => new URL(url).hostname === '127.0.0.1', timeoutMs: 1000 })
      expect(await runner.run(entry, async () => ({ username: 'u@x', password: 'pw' }))).toEqual({ status: 'logged_in' })
      expect(existing.isClosed()).toBe(false)
      expect(existing.url()).toBe(`http://127.0.0.1:${fx.port}/`)
      expect((await context.cookies()).some(cookie => cookie.name === 'keep-existing')).toBe(true)
      expect(context.pages()).toContain(existing)
      expect(context.pages().filter(page => page !== existing).every(page => page.url() !== `http://127.0.0.1:${fx.port}/protected-dash`)).toBe(true)
    } finally { await privateBrowser.close(); await existing.close(); await provider.disconnect(); await independent.close() }
  })
})
