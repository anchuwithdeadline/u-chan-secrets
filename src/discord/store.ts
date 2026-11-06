import { lstat, readFile, open, rename, unlink } from 'node:fs/promises'
import { dirname, resolve, parse } from 'node:path'
import { randomUUID } from 'node:crypto'
import { connectionSchema, type DiscordConnection } from './policy.js'

export class DiscordStore {
  constructor(private readonly path: string, private readonly beforeWrite: () => Promise<void> = async () => {}) {}
  private async safePath(): Promise<void> {
    for (let p = resolve(this.path);;) {
      try { if ((await lstat(p)).isSymbolicLink()) throw new Error('Discord state refuses links') }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
      if (p === parse(p).root) break
      p = dirname(p)
    }
  }
  async list(): Promise<DiscordConnection[]> {
    await this.safePath()
    let raw: string
    try {
      if ((await lstat(this.path)).size > 65536) throw new Error('Discord connection state is invalid')
      raw = await readFile(this.path, 'utf8')
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
    try {
      const data: unknown = JSON.parse(raw)
      if (!Array.isArray(data) || data.length > 50) throw new Error()
      const entries = data.map(e => connectionSchema.parse(e))
      if (new Set(entries.map(e => e.alias)).size !== entries.length) throw new Error()
      return entries
    } catch { throw new Error('Discord connection state is invalid') }
  }
  async get(alias: string): Promise<DiscordConnection | undefined> { return (await this.list()).find(e => e.alias === alias) }
  async upsert(connection: DiscordConnection): Promise<void> {
    const entry = connectionSchema.parse(connection)
    const entries = (await this.list()).filter(e => e.alias !== entry.alias)
    await this.write([...entries, entry])
  }
  async remove(alias: string): Promise<boolean> {
    const entries = await this.list(), rest = entries.filter(e => e.alias !== alias)
    if (rest.length === entries.length) return false
    await this.write(rest)
    return true
  }
  private async write(entries: DiscordConnection[]): Promise<void> {
    if (entries.length > 50 || Buffer.byteLength(JSON.stringify(entries)) > 65536) throw new Error('Discord connection state is full')
    await this.beforeWrite()
    await this.safePath()
    const temp = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify(entries, null, 2))
      await file.sync()
      await file.close()
      await this.safePath()
      await rename(temp, this.path)
    } finally { await file.close(); await unlink(temp).catch(() => {}) }
  }
}
