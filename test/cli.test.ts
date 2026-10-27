import { describe, expect, it, vi } from 'vitest'
import { importTimeoutMs, main } from '../src/cli.js'
import { MAX_FRAME } from '../src/ipc/protocol.js'
import type { ControlApi } from '../src/core/types.js'

const fakeClient = (ok = true) => ({
  unlock: vi.fn(async () => ({ ok, message: ok ? 'unlocked' : 'wrong password' })),
  lock: vi.fn(async () => ({ ok, message: 'locked' })),
  setMode: vi.fn(async (m: string) => ({ ok, message: m })),
  importV1: vi.fn(async (_e: unknown[]) => ({ ok, message: 'imported 1 of 1' })),
})

const DEFAULT_V1 = 'C:\\Users\\me\\AppData\\Roaming\\u-chan-secrets\\allowlist.json'
const ENTRY = { domain: 'a.com', hosts: ['a.com'], loginUrl: 'https://a.com/l', item: 'A' }

const run = async (argv: string[], client = fakeClient(), files: Record<string, string> = {}) => {
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
    const r = await run(['import-v1'], c, { [DEFAULT_V1]: JSON.stringify(entries) })
    expect(r).toMatchObject({ code: 0, out: ['imported 1 of 1'] })
    expect(c.importV1).toHaveBeenCalledWith(entries)
  })
  it('import-v1 waits 2 minutes per entry plus a margin', async () => {
    const entries = [ENTRY, { ...ENTRY, domain: 'b.com' }, { ...ENTRY, domain: 'c.com' }]
    const r = await run(['import-v1', 'v1.json'], fakeClient(), { 'v1.json': JSON.stringify(entries) })
    expect(r.code).toBe(0)
    expect(importTimeoutMs(3)).toBe(3 * 120000 + 60000)
    expect(r.connect).toHaveBeenCalledWith({ timeoutMs: importTimeoutMs(3) })
    expect(importTimeoutMs(3)).toBeGreaterThan(180000)
  })
  it('import-v1 accepts a BOM-prefixed file', async () => {
    const c = fakeClient()
    const r = await run(['import-v1', 'bom.json'], c, { 'bom.json': '\uFEFF' + JSON.stringify([ENTRY]) })
    expect(r.code).toBe(0)
    expect(c.importV1).toHaveBeenCalledWith([ENTRY])
  })
  it('import-v1 tells a missing file, an unreadable file, invalid JSON and a non-array apart', async () => {
    const c = fakeClient()
    expect(await run(['import-v1', 'x.json'], c)).toMatchObject({ code: 1, err: ['no V1 allowlist found at x.json'] })
    expect(await run(['import-v1', 'locked.json'], c)).toMatchObject({ code: 1, err: ['could not read locked.json (EACCES)'] })
    expect(await run(['import-v1', 'z.json'], c, { 'z.json': 'not json' })).toMatchObject({ code: 1, err: ['z.json is not valid JSON'] })
    expect(await run(['import-v1', 'y.json'], c, { 'y.json': '{"a":1}' })).toMatchObject({
      code: 1,
      err: ['y.json is not a V1 allowlist (expected a JSON array)'],
    })
    expect(c.importV1).not.toHaveBeenCalled()
  })
  it('import-v1 refuses a file too large for one IPC frame', async () => {
    const c = fakeClient()
    const big = Array.from({ length: 2000 }, (_, i) => ({ ...ENTRY, domain: `d${i}.example.com`, item: 'x'.repeat(40) }))
    expect(JSON.stringify(big).length).toBeGreaterThan(MAX_FRAME)
    const r = await run(['import-v1', 'big.json'], c, { 'big.json': JSON.stringify(big) })
    expect(r).toMatchObject({ code: 1, err: ['V1 allowlist is too large to import in one go'] })
    expect(c.importV1).not.toHaveBeenCalled()
    expect(r.connect).not.toHaveBeenCalled()
  })
  it('unknown command prints usage and exits 1', async () => {
    const r = await run([])
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/usage: u-chan/)
  })
})
