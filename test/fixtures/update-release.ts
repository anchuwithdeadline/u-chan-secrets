import { gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'

export function archive(entries: Array<{ name: string; data?: string | Buffer; type?: string }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? ''), h = Buffer.alloc(512)
    h.write(entry.name, 0, 100)
    h.write('0000644\0', 100); h.write('0000000\0', 108); h.write('0000000\0', 116)
    h.write(data.length.toString(8).padStart(11, '0') + '\0', 124)
    h.write('00000000000\0', 136); h.fill(32, 148, 156)
    h.write(entry.type ?? '0', 156); h.write('ustar\0', 257); h.write('00', 263)
    h.write([...h].reduce((sum, n) => sum + n, 0).toString(8).padStart(6, '0') + '\0 ', 148)
    chunks.push(h, data, Buffer.alloc((512 - data.length % 512) % 512))
  }
  return gzipSync(Buffer.concat([...chunks, Buffer.alloc(1024)]))
}
export function release(version = '2.1.0', extra: Record<string, string> = {}): Buffer {
  const files: Record<string, string> = {
    'package.json': JSON.stringify({ name: 'u-chan-secrets', version, engines: { node: '>=24' }, dependencies: {} }),
    'dist/index.js': 'index', 'dist/cli.js': 'cli', 'dist/service/main.js': 'service',
    'dist/service/update/worker-main.js': 'worker',
    ...Object.fromEntries(['prompt-src.js', 'auth-src.js', 'service-src.js'].map(name => ['dist/platform/windows/assets/' + name, 'native'])),
    ...extra,
  }
  return archive(Object.entries(files).map(([name, data]) => ({ name: 'package/' + name, data })))
}
export const integrity = (bytes: Buffer) => 'sha512-' + createHash('sha512').update(bytes).digest('base64')
