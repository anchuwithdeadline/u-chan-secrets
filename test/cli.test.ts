import { describe, expect, it, vi } from 'vitest'
import { importTimeoutMs, main } from '../src/cli.js'
import { MAX_FRAME } from '../src/ipc/protocol.js'
import type { ControlApi, ToolResult } from '../src/core/types.js'

const fakeClient = (ok = true) => ({
  unlock: vi.fn(async () => ({ ok, message: ok ? 'unlocked' : 'wrong password' })),
  lock: vi.fn(async () => ({ ok, message: 'locked' })),
  setMode: vi.fn(async (m: string) => ({ ok, message: m })),
  importV1: vi.fn(async (_e: unknown[]) => ({ ok, message: 'imported 1 of 1' })),
  audit: vi.fn(async (_limit?: number) => ({ ok, message: ok ? '2026-10-27T... login ok' : 'wrong password' })),
})

const DEFAULT_V1 = 'C:\\Users\\me\\AppData\\Roaming\\u-chan-secrets\\allowlist.json'
const ENTRY = { domain: 'a.com', hosts: ['a.com'], loginUrl: 'https://a.com/l', item: 'A' }

interface RunOptions {
  client?: ReturnType<typeof fakeClient>
  files?: Record<string, string>
  install?: (opts: any) => Promise<ToolResult>
  uninstall?: () => Promise<ToolResult>
}

const run = async (argv: string[], opts: RunOptions | ReturnType<typeof fakeClient> = {}) => {
  const options: RunOptions = typeof opts === 'object' && 'unlock' in opts ? { client: opts } : opts
  const client = options.client ?? fakeClient()
  const files = options.files ?? {}
  const out: string[] = []
  const err: string[] = []
  const connect = vi.fn((_o: { timeoutMs?: number }) => client as unknown as ControlApi)
  const code = await main(argv, {
    connect,
    env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    platform: 'win32',
    readFile: async (p) => {
      if (p in files) return files[p]
      if (p === 'locked.json') throw Object.assign(new Error('nope'), { code: 'EACCES' })
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    },
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
    install: options.install,
    uninstall: options.uninstall,
  })
  return { code, out, err, connect }
}

describe('cli', () => {
  it('exits 1 on failure', async () => {
    const r = await run(['unlock'], fakeClient(false))
    expect(r.code).toBe(1)
    expect(r.err).toEqual(['wrong password'])
  })
  it('unlock / lock print the message and exit 0', async () => {
    const c = fakeClient()
    expect(await run(['unlock'], c)).toMatchObject({ code: 0, out: ['unlocked'] })
    expect(await run(['lock'], c)).toMatchObject({ code: 0, out: ['locked'] })
  })
  it('unlock uses the client default timeout', async () => {
    const r = await run(['unlock'])
    expect(r.connect).toHaveBeenCalledWith({})
  })
  it('mode validates its argument', async () => {
    const c = fakeClient()
    expect((await run(['mode', 'hardcore'], c)).code).toBe(0)
    expect(c.setMode).toHaveBeenCalledWith('hardcore')
    expect((await run(['mode', 'turbo'], c)).code).toBe(1)
    expect(c.setMode).toHaveBeenCalledTimes(1)
  })
  it('import-v1 reads the default V1 allowlist and sends the parsed array', async () => {
    const c = fakeClient()
    const entries = [ENTRY]
    const r = await run(['import-v1'], { client: c, files: { [DEFAULT_V1]: JSON.stringify(entries) } })
    expect(r).toMatchObject({ code: 0, out: ['imported 1 of 1'] })
    expect(c.importV1).toHaveBeenCalledWith(entries)
  })
  it('import-v1 waits 2 minutes per entry plus a margin', async () => {
    const entries = [ENTRY, { ...ENTRY, domain: 'b.com' }, { ...ENTRY, domain: 'c.com' }]
    const r = await run(['import-v1', 'v1.json'], { client: fakeClient(), files: { 'v1.json': JSON.stringify(entries) } })
    expect(r.code).toBe(0)
    expect(importTimeoutMs(3)).toBe(3 * 120000 + 60000)
    expect(r.connect).toHaveBeenCalledWith({ timeoutMs: importTimeoutMs(3) })
    expect(importTimeoutMs(3)).toBeGreaterThan(180000)
  })
  it('import-v1 accepts a BOM-prefixed file', async () => {
    const c = fakeClient()
    const r = await run(['import-v1', 'bom.json'], { client: c, files: { 'bom.json': '\uFEFF' + JSON.stringify([ENTRY]) } })
    expect(r.code).toBe(0)
    expect(c.importV1).toHaveBeenCalledWith([ENTRY])
  })
  it('import-v1 tells a missing file, an unreadable file, invalid JSON and a non-array apart', async () => {
    const c = fakeClient()
    expect(await run(['import-v1', 'x.json'], c)).toMatchObject({ code: 1, err: ['no V1 allowlist found at x.json'] })
    expect(await run(['import-v1', 'locked.json'], c)).toMatchObject({ code: 1, err: ['could not read locked.json (EACCES)'] })
    expect(await run(['import-v1', 'z.json'], { client: c, files: { 'z.json': 'not json' } })).toMatchObject({ code: 1, err: ['z.json is not valid JSON'] })
    expect(await run(['import-v1', 'y.json'], { client: c, files: { 'y.json': '{"a":1}' } })).toMatchObject({
      code: 1,
      err: ['y.json is not a V1 allowlist (expected a JSON array)'],
    })
    expect(c.importV1).not.toHaveBeenCalled()
  })
  it('import-v1 refuses a file too large for one IPC frame', async () => {
    const c = fakeClient()
    const big = Array.from({ length: 2000 }, (_, i) => ({ ...ENTRY, domain: `d${i}.example.com`, item: 'x'.repeat(40) }))
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_FRAME)
    const r = await run(['import-v1', 'big.json'], { client: c, files: { 'big.json': JSON.stringify(big) } })
    expect(r).toMatchObject({ code: 1, err: ['V1 allowlist is too large to import in one go'] })
    expect(c.importV1).not.toHaveBeenCalled()
    expect(r.connect).not.toHaveBeenCalled()
  })
  it('dispatches install command with options', async () => {
    const install = vi.fn(async () => ({ ok: true, message: 'installed' }))
    const r = await run(['install', '--mode', 'hardcore', '--phrase', 'blue otter'], { install })
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['installed'])
    expect(install).toHaveBeenCalledWith({ mode: 'hardcore', phrase: 'blue otter' })
  })
  it('dispatches uninstall command', async () => {
    const uninstall = vi.fn(async () => ({ ok: true, message: 'uninstalled' }))
    const r = await run(['uninstall'], { uninstall })
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['uninstalled'])
    expect(uninstall).toHaveBeenCalled()
  })
  it('install failure returns exit code 1', async () => {
    const install = vi.fn(async () => ({ ok: false, message: 'install failed' }))
    const r = await run(['install'], { install })
    expect(r.code).toBe(1)
    expect(r.err).toEqual(['install failed'])
  })
  it('install with invalid options prints usage and exits 1', async () => {
    const install = vi.fn()
    const r = await run(['install', '--bad'], { install })
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/usage: u-chan/)
    expect(install).not.toHaveBeenCalled()
  })
  it('audit prints formatted log and exits 0', async () => {
    const c = fakeClient()
    const r = await run(['audit'], c)
    expect(r.code).toBe(0)
    expect(r.out).toEqual(['2026-10-27T... login ok'])
    expect(c.audit).toHaveBeenCalledWith(undefined)
  })
  it('audit passes parsed limit', async () => {
    const c = fakeClient()
    const r = await run(['audit', '25'], c)
    expect(r.code).toBe(0)
    expect(c.audit).toHaveBeenCalledWith(25)
  })
  it('audit rejects non-positive or non-integer audit limit', async () => {
    const c = fakeClient()
    const r1 = await run(['audit', 'abc'], c)
    expect(r1.code).toBe(1)
    expect(r1.err).toEqual(['limit must be a positive integer'])

    const r2 = await run(['audit', '-5'], c)
    expect(r2.code).toBe(1)
    expect(r2.err).toEqual(['limit must be a positive integer'])

    const r3 = await run(['audit', '0'], c)
    expect(r3.code).toBe(1)
    expect(r3.err).toEqual(['limit must be a positive integer'])

    const r4 = await run(['audit', '1.5'], c)
    expect(r4.code).toBe(1)
    expect(r4.err).toEqual(['limit must be a positive integer'])

    expect(c.audit).not.toHaveBeenCalled()
  })
  it('audit reports service errors', async () => {
    const c = fakeClient(false)
    c.audit.mockResolvedValue({ ok: false, message: 'U-Chan service is not running — run u-chan install' })
    const r = await run(['audit'], c)
    expect(r.code).toBe(1)
    expect(r.err).toEqual(['U-Chan service is not running — run u-chan install'])
  })
  it('usage message includes audit', async () => {
    const r = await run([])
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toContain('audit [limit]')
  })
  it('unknown command prints usage and exits 1', async () => {
    const r = await run([])
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/usage: u-chan/)
  })
})
