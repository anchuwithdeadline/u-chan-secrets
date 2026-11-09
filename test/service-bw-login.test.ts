import { describe, expect, it, vi, beforeEach } from 'vitest'

const cp = vi.hoisted(() => ({ execFile: vi.fn(), spawn: vi.fn() }))
vi.mock('node:child_process', () => cp)

import { ensureServiceBitwardenLogin, serviceBwRunner, serviceBwPaths } from '../src/platform/service-bw-login.js'

const status = (s: string) => ({ code: 0, stdout: JSON.stringify({ status: s }) })
const deps = (run: any, extra: object = {}) => ({ run, interactive: true, manualCommand: 'MANUAL', out: vi.fn(), ...extra })

describe('ensureServiceBitwardenLogin', () => {
  it('does nothing when already logged in', async () => {
    const run = vi.fn(async () => status('locked'))
    expect(await ensureServiceBitwardenLogin(deps(run))).toBe('already')
    expect(run).toHaveBeenCalledOnce()
  })
  it('locks the private vault right after login', async () => {
    const run = vi.fn(async (a: string[], _o?: object) => a[0] === 'status' ? status('unauthenticated') : { code: 0, stdout: '' })
    expect(await ensureServiceBitwardenLogin(deps(run))).toBe('logged_in')
    expect(run.mock.calls.map(c => c[0][0])).toEqual(['status', 'login', 'lock'])
    expect(run.mock.calls[1][1]).toEqual({ interactive: true })
  })
  it('skips login without a TTY and prints the manual command', async () => {
    const run = vi.fn(async () => status('unauthenticated')), out = vi.fn()
    expect(await ensureServiceBitwardenLogin(deps(run, { interactive: false, out }))).toBe('skipped')
    expect(out.mock.calls.flat().join('\n')).toContain('MANUAL')
    expect(run).toHaveBeenCalledOnce()
  })
  it('fails and prints the manual command when login exits non-zero', async () => {
    const run = vi.fn(async (a: string[]) => a[0] === 'status' ? status('unauthenticated') : { code: 1, stdout: '' }), out = vi.fn()
    expect(await ensureServiceBitwardenLogin(deps(run, { out }))).toBe('failed')
    expect(run.mock.calls.map(c => c[0][0])).toEqual(['status', 'login'])
    expect(out.mock.calls.flat().join('\n')).toContain('MANUAL')
  })
  it('fails with a lock warning when lock exits non-zero', async () => {
    const run = vi.fn(async (a: string[]) => a[0] === 'status' ? status('unauthenticated') : { code: a[0] === 'lock' ? 1 : 0, stdout: '' }), out = vi.fn()
    expect(await ensureServiceBitwardenLogin(deps(run, { out }))).toBe('failed')
    const text = out.mock.calls.flat().join('
')
    expect(text).toContain('lock failed')
    expect(text).toContain('MANUAL')
    expect(text).not.toContain('login still needed')
  })
  it('fails with a lock warning when lock throws', async () => {
    const run = vi.fn(async (a: string[]) => { if (a[0] === 'lock') throw new Error('timeout'); return a[0] === 'status' ? status('unauthenticated') : { code: 0, stdout: '' } }), out = vi.fn()
    expect(await ensureServiceBitwardenLogin(deps(run, { out }))).toBe('failed')
    const text = out.mock.calls.flat().join('
')
    expect(text).toContain('lock failed')
    expect(text).not.toContain('login still needed')
  })
  it('fails and prints the manual command when bw is missing', async () => {
    const run = vi.fn(async () => { throw new Error('ENOENT') }), out = vi.fn()
    expect(await ensureServiceBitwardenLogin(deps(run, { out }))).toBe('failed')
    expect(out.mock.calls.flat().join('\n')).toContain('MANUAL')
  })
})

describe('serviceBwRunner', () => {
  beforeEach(() => { cp.execFile.mockReset(); cp.spawn.mockReset() })
  it('removes BW_SESSION and sets the private data dir', async () => {
    cp.execFile.mockImplementation((_f: string, _a: string[], _o: any, cb: any) => cb(null, 'out', ''))
    const res = await serviceBwRunner('bw', 'D', { BW_SESSION: 'x', PATH: 'p' })(['status'], { interactive: false })
    expect(res).toEqual({ code: 0, stdout: 'out' })
    const env = cp.execFile.mock.calls[0][2].env
    expect(env.BW_SESSION).toBeUndefined()
    expect(env.BITWARDENCLI_APPDATA_DIR).toBe('D')
    expect(env.PATH).toBe('p')
  })
  it('interactive uses inherited stdio and the same env', async () => {
    cp.spawn.mockImplementation(() => ({ on: (e: string, cb: any) => { if (e === 'close') cb(0) } }))
    const res = await serviceBwRunner('bw', 'D', { BW_SESSION: 'x' })(['login'], { interactive: true })
    expect(res.code).toBe(0)
    const o = cp.spawn.mock.calls[0][2]
    expect(o.stdio).toBe('inherit')
    expect(o.env.BW_SESSION).toBeUndefined()
    expect(o.env.BITWARDENCLI_APPDATA_DIR).toBe('D')
  })
  it('non-zero execFile exit resolves with its code', async () => {
    cp.execFile.mockImplementation((_f: string, _a: string[], _o: any, cb: any) => cb(Object.assign(new Error('x'), { code: 2 }), '', ''))
    expect((await serviceBwRunner('bw', 'D', {})(['lock'], { interactive: false })).code).toBe(2)
  })
})

describe('serviceBwPaths', () => {
  it('maps platforms', () => {
    expect(serviceBwPaths('win32')?.bwPath).toMatch(/bw\.exe$/)
    expect(serviceBwPaths('darwin')?.bwPath).toBe('/Library/Application Support/u-chan-secrets/bin/bw')
    expect(serviceBwPaths('win32')?.manualCommand).not.toMatch(/[\x00-\x08]/)
    expect(serviceBwPaths('win32')?.manualCommand).toContain(String.raw`u-chan-secrets\bin\bw.exe`)
    expect(serviceBwPaths('linux')).toBeNull()
  })
})
