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
  it('reports Chrome not running as a user-facing error', async () => {
    const p = new CdpBrowserProvider(`http://127.0.0.1:${await freePort()}`)
    expect(await p.connected()).toBe(false)
    await expect(p.withPage(async () => 1)).rejects.toThrow(UserFacingError)
  })
})
