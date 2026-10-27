import { describe, expect, it, vi } from 'vitest'
import { main } from '../src/cli.js'
import type { ControlApi } from '../src/core/types.js'

const fakeClient = (ok = true) => ({
  unlock: vi.fn(async () => ({ ok, message: ok ? 'unlocked' : 'wrong password' })),
  lock: vi.fn(async () => ({ ok, message: 'locked' })),
  setMode: vi.fn(async (m: string) => ({ ok, message: m })),
  importV1: vi.fn(async (_e: unknown[]) => ({ ok, message: 'imported 1 of 1' })),
})

const DEFAULT_V1 = 'C:\\Users\\me\\AppData\\Roaming\\u-chan-secrets\\allowlist.json'

const run = async (argv: string[], client = fakeClient(), files: Record<string, string> = {}) => {
  const out: string[] = []
  const err: string[] = []
  const code = await main(argv, {
    client: client as unknown as ControlApi,
    env: { APPDATA: 'C:\\Users\\me\\AppData\\Roaming' },
    platform: 'win32',
    readFile: async (p) => {
      if (p in files) return files[p]
      throw Object.assign(new Error('nope'), { code: 'ENOENT' })
    },
    out: (s) => void out.push(s),
    err: (s) => void err.push(s),
  })
  return { code, out, err }
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
  it('mode validates its argument', async () => {
    const c = fakeClient()
    expect((await run(['mode', 'hardcore'], c)).code).toBe(0)
    expect(c.setMode).toHaveBeenCalledWith('hardcore')
    expect((await run(['mode', 'turbo'], c)).code).toBe(1)
    expect(c.setMode).toHaveBeenCalledTimes(1)
  })
  it('import-v1 reads the default V1 allowlist and sends the parsed array', async () => {
    const c = fakeClient()
    const entries = [{ domain: 'a.com', hosts: ['a.com'], loginUrl: 'https://a.com/l', item: 'A' }]
    const r = await run(['import-v1'], c, { [DEFAULT_V1]: JSON.stringify(entries) })
    expect(r).toMatchObject({ code: 0, out: ['imported 1 of 1'] })
    expect(c.importV1).toHaveBeenCalledWith(entries)
  })
  it('import-v1 rejects a missing, invalid or non-array file without calling the service', async () => {
    const c = fakeClient()
    expect((await run(['import-v1', 'x.json'], c)).code).toBe(1)
    expect((await run(['import-v1', 'y.json'], c, { 'y.json': '{"a":1}' })).code).toBe(1)
    expect((await run(['import-v1', 'z.json'], c, { 'z.json': 'not json' })).code).toBe(1)
    expect(c.importV1).not.toHaveBeenCalled()
  })
  it('unknown command prints usage and exits 1', async () => {
    const r = await run([])
    expect(r.code).toBe(1)
    expect(r.err.join('\n')).toMatch(/usage: u-chan/)
  })
})
