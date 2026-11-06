import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { versionSchema } from './protocol.js'

export const nativeFiles = ['prompt-src.js', 'auth-src.js', 'service-src.js'] as const
export interface ReleaseManifest { version: string; files: Map<string, Buffer>; dependencies: Record<string, string>; node: string }
export const artifactIntegrity = (bytes: Buffer): string => 'sha512-' + createHash('sha512').update(bytes).digest('base64')
export function safeReleasePath(path: string): boolean {
  if (!path || path.length > 240 || /[\\:\s\p{Cc}\p{Cf}]/u.test(path)) return false
  return path.split('/').every(p => p && p !== '.' && p !== '..' && !/[. ]$/.test(p) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))
}
/** Conservative npm tar reader: unsupported extended metadata fails closed instead of changing paths. */
export function inspectRelease(tarball: Buffer): ReleaseManifest {
  try {
    if (tarball.length > 32 * 1024 * 1024) throw new Error()
    const tar = gunzipSync(tarball, { maxOutputLength: 64 * 1024 * 1024 })
    const files = new Map<string, Buffer>(), seen = new Set<string>()
    let offset = 0, count = 0, ended = false
    const string = (buf: Buffer) => { const zero = buf.indexOf(0); const end = zero < 0 ? buf.length : zero; if (zero >= 0 && buf.subarray(zero).some(n => n !== 0)) throw new Error(); return buf.subarray(0, end).toString('utf8') }
    const octal = (buf: Buffer) => { const v = buf.toString('ascii').replace(/[\0 ]/g, ''); if (!/^[0-7]+$/.test(v)) throw new Error(); return parseInt(v, 8) }
    while (offset + 512 <= tar.length) {
      const header = tar.subarray(offset, offset + 512)
      if (header.every(n => n === 0)) {
        if (tar.length - offset < 1024 || tar.subarray(offset).some(n => n !== 0)) throw new Error()
        ended = true; break
      }
      if (++count > 2000) throw new Error()
      const sum = [...header].reduce((s, n, i) => s + (i >= 148 && i < 156 ? 32 : n), 0)
      if (sum !== octal(header.subarray(148, 156))) throw new Error()
      const prefix = string(header.subarray(345, 500)), name = (prefix ? prefix + '/' : '') + string(header.subarray(0, 100))
      const type = header[156], size = octal(header.subarray(124, 136))
      if (type !== 0 && type !== 48 && type !== 53) throw new Error()
      if (string(header.subarray(157, 257))) throw new Error()
      const path = name.replace(/\/$/, '')
      if (!path.startsWith('package/') && path !== 'package') throw new Error()
      const relative = path.slice(8)
      if (relative && (!safeReleasePath(relative) || !/^(dist\/|scripts\/|package.json$|README.md$|LICENSE$)/.test(relative))) throw new Error()
      const key = path.toLowerCase()
      if (seen.has(key)) throw new Error(); seen.add(key)
      const end = offset + 512 + size
      if (!Number.isSafeInteger(size) || size < 0 || end > tar.length || (type === 53 && size !== 0)) throw new Error()
      if (type !== 53) { if (!relative) throw new Error(); files.set(relative, Buffer.from(tar.subarray(offset + 512, end))) }
      offset += 512 + Math.ceil(size / 512) * 512
    }
    if (!ended) throw new Error()
    const pkg = JSON.parse(files.get('package.json')?.toString('utf8') ?? '')
    if (pkg.name !== 'u-chan-secrets' || !versionSchema.safeParse(pkg.version).success || !pkg.engines || typeof pkg.engines.node !== 'string') throw new Error()
    for (const file of ['dist/index.js', 'dist/cli.js', 'dist/service/main.js', 'dist/service/update/worker-main.js']) if (!files.has(file)) throw new Error()
    const dependencies = pkg.dependencies ?? {}
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies) || Object.entries(dependencies).some(([k, v]) => typeof v !== 'string' || !k || k.length > 200)) throw new Error()
    return { version: pkg.version, files, dependencies, node: pkg.engines.node }
  } catch { throw new Error('invalid_or_unsupported_release') }
}
export function compatibleRelease(manifest: ReleaseManifest, installed: { dependencies: Record<string, string>; native: Record<string, Buffer> }, nodeVersion: string): string | null {
  const floor = /^>=\s*(\d+)(?:\.(\d+)(?:\.(\d+))?)?$/.exec(manifest.node), current = nodeVersion.split('.').map(Number)
  if (!floor) return 'runtime_changed'
  const wanted = floor.slice(1).map(v => Number(v ?? 0))
  let supported = true
  for (let i = 0; i < 3; i++) { if (current[i] !== wanted[i]) { supported = current[i] > wanted[i]; break } }
  if (!supported) return 'runtime_changed'
  const sorted = (v: Record<string, string>) => JSON.stringify(Object.entries(v).sort(([a],[b]) => a.localeCompare(b)))
  if (sorted(manifest.dependencies) !== sorted(installed.dependencies)) return 'dependencies_changed'
  for (const name of nativeFiles) { const next = manifest.files.get('dist/platform/windows/assets/' + name); if (!next || !installed.native[name] || !next.equals(installed.native[name])) return 'native_helpers_changed' }
  return null
}
