import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, resolveLoginBrowser } from '../src/core/config.js'
import { readBrowserChoice, saveBrowserChoice } from '../src/client/browser-choice.js'
const directories: string[] = []
async function fixture() { const dir = await mkdtemp(join(tmpdir(), 'ucs-browser-choice-')); directories.push(dir); return dir }
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('defaults to Chrome and preserves custom CDP and the legacy Chrome profile', async () => {
  const dir = await fixture(), c = loadConfig({ U_CHAN_HOME: dir, U_CHAN_CDP: 'http://127.0.0.1:9333' }, 'win32')
  expect(c).toMatchObject({ browser: 'chrome', browserProfile: join(dir, 'chrome-profile'), chromeProfile: join(dir, 'chrome-profile'), cdpEndpoint: 'http://127.0.0.1:9333' })
})
it('persists Edge independently, backs up before replacement, and omission never resets it', async () => {
  const dir = await fixture(), file = join(dir, 'browser.json')
  expect(readBrowserChoice(file)).toBeUndefined()
  expect(await saveBrowserChoice(file, 'edge')).toMatchObject({ changed: true })
  expect(readBrowserChoice(file)).toBe('edge')
  expect(loadConfig({ U_CHAN_HOME: dir }, 'win32')).toMatchObject({ browser: 'edge', browserProfile: join(dir, 'edge-profile') })
  expect(await saveBrowserChoice(file, 'edge')).toEqual({ changed: false })
  const change = await saveBrowserChoice(file, 'chrome')
  expect(JSON.parse(await readFile(change.backupPath!, 'utf8'))).toEqual({ browser: 'edge' })
  expect(readBrowserChoice(file)).toBe('chrome')
})
it('explicit operation environment wins without mutating saved preference', async () => {
  const dir = await fixture(), file = join(dir, 'browser.json')
  await saveBrowserChoice(file, 'edge')
  expect(loadConfig({ U_CHAN_HOME: dir, U_CHAN_BROWSER: 'chrome' }, 'win32').browser).toBe('chrome')
  expect(readBrowserChoice(file)).toBe('edge')
})
it('refuses stale MCP browser environment for login rather than silently selecting another browser', async () => {
  const dir = await fixture()
  await saveBrowserChoice(join(dir,'browser.json'),'edge')
  expect(() => resolveLoginBrowser({U_CHAN_HOME:dir,U_CHAN_BROWSER:'chrome'},'win32')).toThrow(/restart/i)
  expect(resolveLoginBrowser({U_CHAN_HOME:dir,U_CHAN_BROWSER:'edge'},'win32')).toBe('edge')
})
it('fails closed on invalid or malformed existing browser selection', async () => {
  const dir = await fixture(), file = join(dir, 'browser.json')
  for (const text of ['{', '{"browser":"firefox"}', '{"browser":"edge","extra":true}', '[]']) {
    await writeFile(file, text)
    expect(() => loadConfig({ U_CHAN_HOME: dir }, 'win32')).toThrow(/browser/i)
    await expect(saveBrowserChoice(file, 'edge')).rejects.toThrow()
    expect(await readFile(file, 'utf8')).toBe(text)
  }
  expect(() => loadConfig({ U_CHAN_HOME: dir, U_CHAN_BROWSER: 'oops' }, 'win32')).toThrow(/browser/i)
})
it('refuses redirected preference files without changing the destination', async () => {
  if (process.platform === 'win32') return // creating file symlinks requires additional Windows privileges
  const dir = await fixture(), original = join(dir, 'original.json'), file = join(dir, 'browser.json')
  await writeFile(original, '{"browser":"chrome"}')
  await symlink(original, file)
  expect(() => readBrowserChoice(file)).toThrow()
  await expect(saveBrowserChoice(file, 'edge')).rejects.toThrow()
  expect(await readFile(original, 'utf8')).toBe('{"browser":"chrome"}')
})
