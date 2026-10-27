import { describe, it, expect } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AllowlistStore, isHostAllowed, buildEntry } from '../src/core/allowlist.js'
import { UserFacingError, type AllowEntry } from '../src/core/types.js'

const entry: AllowEntry = { domain: 'admin.example.com', hosts: ['admin.example.com'], loginUrl: 'https://admin.example.com/login', item: 'Example' }

describe('isHostAllowed', () => {
  it('allows exact https host', () => expect(isHostAllowed(entry, 'https://admin.example.com/login')).toBe(true))
  it('is case-insensitive on hostname', () => expect(isHostAllowed(entry, 'https://ADMIN.example.com/')).toBe(true))
  it('no wildcard subdomains', () => expect(isHostAllowed(entry, 'https://evil.example.com/login')).toBe(false))
  it('rejects suffix trick', () => expect(isHostAllowed(entry, 'https://admin.example.com.evil.com/')).toBe(false))
  it('rejects userinfo trick', () => expect(isHostAllowed(entry, 'https://admin.example.com@evil.com/')).toBe(false))
  it('rejects http', () => expect(isHostAllowed(entry, 'http://admin.example.com/')).toBe(false))
  it('rejects malformed hosts (string, non-string elements)', () => {
    expect(isHostAllowed({ ...entry, hosts: 'admin.example.com' as never }, 'https://example/')).toBe(false)
    expect(isHostAllowed({ ...entry, hosts: 'admin.example.com' as never }, 'https://admin.example.com/')).toBe(false)
    expect(isHostAllowed({ ...entry, hosts: ['admin.example.com', 1] as never }, 'https://admin.example.com/')).toBe(false)
  })
  it('rejects invalid url', () => expect(isHostAllowed(entry, 'not a url')).toBe(false))
})

describe('buildEntry', () => {
  it('rejects non-https loginUrl', () => {
    expect(() => buildEntry('admin.example.com', 'http://x', 'item')).toThrow(UserFacingError)
  })
  it('rejects invalid loginUrl', () => {
    expect(() => buildEntry('admin.example.com', 'nonsense', 'item')).toThrow(UserFacingError)
  })
  it('rejects empty domain', () => {
    expect(() => buildEntry('https:///', 'https://a.com/', 'item')).toThrow(UserFacingError)
    expect(() => buildEntry('  ', 'https://a.com/', 'item')).toThrow(UserFacingError)
  })
  it('unions hosts, dedupes, lowercases', () => {
    const e = buildEntry('admin.example.com', 'https://auth.example.com/login', 'Example')
    expect(e.hosts).toEqual(['admin.example.com', 'auth.example.com'])
    expect(e.domain).toBe('admin.example.com')
  })
  it('normalizes domain given as URL', () => {
    const e = buildEntry('https://Admin.example.com/x/y', 'https://admin.example.com/login', 'Example')
    expect(e.domain).toBe('admin.example.com')
    expect(e.hosts).toEqual(['admin.example.com'])
  })
  it('merges existing hosts', () => {
    const e = buildEntry('admin.example.com', 'https://auth.example.com/', 'Example', { ...entry, hosts: ['admin.example.com', 'sso.example.com'] })
    expect(e.hosts).toEqual(['admin.example.com', 'sso.example.com', 'auth.example.com'])
  })
})

describe('AllowlistStore', () => {
  it('upsert/get/remove and missing file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uchan-'))
    try {
      const s = new AllowlistStore(join(dir, 'allowlist.json'))
      expect(await s.list()).toEqual([])
      await s.upsert(entry)
      expect(await s.get('admin.example.com')).toEqual(entry)
      await s.upsert({ ...entry, item: 'New' })
      expect((await s.list()).length).toBe(1)
      expect(await s.remove('admin.example.com')).toBe(true)
      expect(await s.get('admin.example.com')).toBeUndefined()
      expect(await s.remove('admin.example.com')).toBe(false)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('normalizes domain in get/remove/upsert', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uchan-'))
    try {
      const s = new AllowlistStore(join(dir, 'a.json'))
      await s.upsert({ ...entry, domain: 'Admin.example.com' })
      expect((await s.get('https://ADMIN.example.com/x'))?.domain).toBe('admin.example.com')
      expect(await s.remove('https://admin.example.com/')).toBe(true)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
  it('throws UserFacingError on invalid JSON or non-array; drops malformed entries', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'uchan-'))
    try {
      const f = join(dir, 'a.json')
      const s = new AllowlistStore(f)
      await writeFile(f, '{nope')
      await expect(s.list()).rejects.toThrow(UserFacingError)
      await writeFile(f, '{"a":1}')
      await expect(s.list()).rejects.toThrow('allowlist.json không hợp lệ')
      await writeFile(f, JSON.stringify([entry, { ...entry, hosts: 'x' }, null, 5, { domain: 'z' }]))
      expect(await s.list()).toEqual([entry])
    } finally { await rm(dir, { recursive: true, force: true }) }
  })
})
