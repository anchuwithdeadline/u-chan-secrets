import { describe, expect, it } from 'vitest'
import { inspectRelease, compatibleRelease } from '../src/service/update/release.js'
import { archive, release } from './fixtures/update-release.js'

describe('verified release inspection', () => {
  it('reads the exact package without extracting or executing it', () => {
    const manifest = inspectRelease(release())
    expect(manifest.version).toBe('2.1.0')
    expect(manifest.files.get('dist/cli.js')?.toString()).toBe('cli')
    expect(compatibleRelease(manifest, { dependencies: {}, native: Object.fromEntries(['prompt-src.js','auth-src.js','service-src.js'].map(k => [k, Buffer.from('native')])) }, '24.1.0')).toBeNull()
  })
  it('rejects unsafe paths, links, collisions, unsupported metadata, and corrupt headers', () => {
    for (const entry of [
      { name: 'package/../escape' }, { name: '/absolute' }, { name: 'package/dist/NUL.js' },
      { name: 'package/dist/x:stream' }, { name: 'package/dist/link', type: '2' }, { name: 'package/pax', type: 'x' },
    ]) expect(() => inspectRelease(archive([entry]))).toThrow()
    expect(() => inspectRelease(archive([{ name: 'package/dist/A.js' }, { name: 'package/dist/a.js' }]))).toThrow()
    expect(() => inspectRelease(Buffer.from('not gzip'))).toThrow()
    expect(() => inspectRelease(Buffer.alloc(32 * 1024 * 1024 + 1))).toThrow()
  })
  it('refuses changed native helpers, dependencies and unsupported runtimes', () => {
    const m = inspectRelease(release())
    expect(compatibleRelease(m, { dependencies: { x: '1' }, native: {} }, '24.0.0')).toBe('dependencies_changed')
    expect(compatibleRelease(m, { dependencies: {}, native: {} }, '24.0.0')).toBe('native_helpers_changed')
    expect(compatibleRelease(m, { dependencies: {}, native: {} }, '22.0.0')).toBe('runtime_changed')
  })
})
