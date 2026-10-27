import { createServer } from 'node:net'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chromium, type Browser } from 'playwright'
import { CdpBrowserProvider } from '../src/core/browser.js'
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
  })
  it('does not launch Chrome just to report status', async () => {
    let calls = 0
    const p = new CdpBrowserProvider(`http://127.0.0.1:${await freePort()}`, { launch: async () => void calls++ })
    expect(await p.connected()).toBe(false)
    expect(calls).toBe(0)
  })
  it('gives a user-facing error when launch never brings CDP up', async () => {
    const p = new CdpBrowserProvider(`http://127.0.0.1:${await freePort()}`, { launch: async () => {}, launchTimeoutMs: 1000 })
    await expect(p.withPage(async () => 1)).rejects.toThrow(/could not start Chrome/)
  })
  it('reports Chrome not running as a user-facing error', async () => {
    const p = new CdpBrowserProvider(`http://127.0.0.1:${await freePort()}`)
    expect(await p.connected()).toBe(false)
    await expect(p.withPage(async () => 1)).rejects.toThrow(UserFacingError)
  })
})
