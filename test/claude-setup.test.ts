import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureClaude } from '../src/client/claude-setup.js'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
const pw = (endpoint = 'http://127.0.0.1:9222') => ({ type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--cdp-endpoint', endpoint], env: {} })
async function fixture(servers?: Record<string, any>) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ucs-claude-'))); dirs.push(home)
  const configPath = join(home, '.claude.json'), configDir = join(home, '.claude')
  const original = JSON.stringify({ oauthAccount: 'SECRET_SENTINEL', ...(servers ? { mcpServers: servers } : {}) })
  await writeFile(configPath, original)
  const calls: string[][] = []
  let mutations = 0, failAt = 0
  const options = { apply: false, replaceExisting: false, endpoint: 'http://127.0.0.1:9222', nodePath: 'C:\\Node\\node.exe', entryPath: 'C:\\U Chan\\dist\\index.js', configPath, configDir, ipcEndpoint: '\\\\.\\pipe\\u-chan' }
  const deps = { elevated: async () => false, read: (p: string) => readFile(p, 'utf8'), exec: async (args: string[]) => {
    calls.push(args)
    expect(args[0]).toBe('mcp')
    mutations++
    if (mutations === failAt) return { code: 1, stdout: '', stderr: 'SECRET_SENTINEL' }
    return { code: 0, stdout: '', stderr: '' }
  } }
  return { options, deps, calls, original, home, failAt: (n: number) => { failAt = n } }
}
it('inspects missing entries read-only without calling the CLI or writing backups', async () => {
  const f = await fixture()
  expect(await configureClaude(f.options, f.deps)).toMatchObject({ state: 'missing', changed: false })
  expect(f.calls).toEqual([])
  expect(await readdir(f.home)).toEqual(['.claude.json'])
})
it('backs up the exact file, then adds user-scope registrations through the official CLI', async () => {
  const f = await fixture({ playwright: pw() })
  const r = await configureClaude({ ...f.options, apply: true, browser: 'edge' }, f.deps)
  expect(r).toMatchObject({ state: 'ready', changed: true })
  expect(r.backupPath!.startsWith(join(f.options.configDir, '#0 backup'))).toBe(true)
  expect(await readFile(r.backupPath!, 'utf8')).toBe(f.original)
  expect(f.calls).toEqual([['mcp', 'add-json', '--scope', 'user', 'u-chan-secrets', JSON.stringify({ type: 'stdio', command: f.options.nodePath, args: [f.options.entryPath], env: { U_CHAN_BROWSER: 'edge', U_CHAN_CDP: f.options.endpoint } })]])
  expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL')
})
it('reports ready without changes when both registrations already match', async () => {
  const f = await fixture({ playwright: pw(), 'u-chan-secrets': { type: 'stdio', command: 'C:\\Node\\node.exe', args: ['C:\\U Chan\\dist\\index.js'], env: {} } })
  expect(await configureClaude({ ...f.options, apply: true }, f.deps)).toMatchObject({ state: 'ready', changed: false })
  expect(f.calls).toEqual([])
})
it('repairs Playwright missing --cdp-endpoint only with explicit replacement', async () => {
  const f = await fixture({ playwright: { type: 'stdio', command: 'npx', args: ['@playwright/mcp@latest'], env: {} }, 'u-chan-secrets': { command: 'C:\\Node\\node.exe', args: ['C:\\U Chan\\dist\\index.js'] } })
  expect(await configureClaude({ ...f.options, apply: true }, f.deps)).toMatchObject({ state: 'needs_update', changed: false })
  expect(f.calls).toEqual([])
  expect(await configureClaude({ ...f.options, apply: true, replaceExisting: true }, f.deps)).toMatchObject({ state: 'ready', changed: true })
  expect(f.calls).toEqual([['mcp', 'remove', '--scope', 'user', 'playwright'], ['mcp', 'add-json', '--scope', 'user', 'playwright', JSON.stringify(pw())]])
})
it('preserves custom registrations and conflicting target environment', async () => {
  for (const servers of [
    { playwright: { ...pw(), args: ['@playwright/mcp@latest', '--headless'] } },
    { playwright: { command: 'cmd', args: ['/c', 'npx', '@playwright/mcp@latest'] } },
    { 'u-chan-secrets': { command: 'node', args: ['x/index.js'], env: { U_CHAN_CDP: 'http://127.0.0.1:9333' } } },
    { 'u-chan-secrets': { command: 'node', args: ['x/index.js'], env: { API_TOKEN: 'SECRET_SENTINEL' } } },
  ]) {
    const f = await fixture(servers)
    const r = await configureClaude({ ...f.options, apply: true, replaceExisting: true }, f.deps)
    expect(r).toMatchObject({ state: 'manual', changed: false })
    expect(f.calls).toEqual([])
    expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL')
  }
})
it('refuses elevation, unsafe targets, and unreadable config before any change', async () => {
  const f = await fixture()
  expect(await configureClaude({ ...f.options, apply: true }, { ...f.deps, elevated: async () => true })).toMatchObject({ state: 'unavailable' })
  expect(await configureClaude({ ...f.options, apply: true, endpoint: 'http://user:SECRET@127.0.0.1:9222' }, f.deps)).toMatchObject({ state: 'manual' })
  await writeFile(f.options.configPath, '{not json')
  expect(await configureClaude({ ...f.options, apply: true }, f.deps)).toMatchObject({ state: 'unavailable' })
  expect(f.calls).toEqual([])
})
it('treats a missing config file as no registrations and retains completed changes on failure', async () => {
  const f = await fixture()
  await rm(f.options.configPath)
  f.failAt(2)
  const r = await configureClaude({ ...f.options, apply: true }, f.deps)
  expect(r).toMatchObject({ state: 'unavailable', changed: true })
  expect(r.backupPath).toBeUndefined()
  expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL')
})
it('replaces a legacy V1 U_CHAN_BW environment only with explicit replacement, without exposing its value', async () => {
  for (const command of ['node', 'C:\\Node\\node.exe']) {
    const f = await fixture({ playwright: pw(), 'u-chan-secrets': { type: 'stdio', command, args: ['C:\\U Chan\\dist\\index.js'], env: { U_CHAN_BW: 'C:\\SECRET_SENTINEL\\bw.exe' } } })
    expect(await configureClaude({ ...f.options, apply: true }, f.deps)).toMatchObject({ state: 'needs_update', changed: false })
    expect(f.calls).toEqual([])
    const r = await configureClaude({ ...f.options, apply: true, replaceExisting: true }, f.deps)
    expect(r).toMatchObject({ state: 'ready', changed: true })
    expect(f.calls).toEqual([['mcp', 'remove', '--scope', 'user', 'u-chan-secrets'], ['mcp', 'add-json', '--scope', 'user', 'u-chan-secrets', JSON.stringify({ type: 'stdio', command: f.options.nodePath, args: [f.options.entryPath], env: {} })]])
    expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL')
  }
})
