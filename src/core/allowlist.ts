import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { UserFacingError, type AllowEntry } from './types.js'

export class AllowlistStore {
  constructor(private readonly path: string) {}

  async list(): Promise<AllowEntry[]> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    return JSON.parse(raw) as AllowEntry[]
  }

  async get(domain: string): Promise<AllowEntry | undefined> {
    const d = domain.trim().toLowerCase()
    return (await this.list()).find((e) => e.domain === d)
  }

  async upsert(entry: AllowEntry): Promise<void> {
    const rest = (await this.list()).filter((e) => e.domain !== entry.domain)
    await this.write([...rest, entry])
  }

  async remove(domain: string): Promise<boolean> {
    const d = domain.trim().toLowerCase()
    const all = await this.list()
    const rest = all.filter((e) => e.domain !== d)
    if (rest.length === all.length) return false
    await this.write(rest)
    return true
  }

  private async write(entries: AllowEntry[]): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(entries, null, 2))
    await rename(tmp, this.path)
  }
}

/** Exact, case-insensitive hostname match over https only. No wildcards. */
export function isHostAllowed(entry: AllowEntry, url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:') return false
  return entry.hosts.includes(u.hostname.toLowerCase())
}

function normalizeDomain(input: string): string {
  const s = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '').split(/[/?#]/)[0]
  if (!s) return ''
  try {
    return new URL(`https://${s}`).hostname
  } catch {
    return ''
  }
}

export function buildEntry(domain: string, loginUrl: string, item: string, existing?: AllowEntry): AllowEntry {
  const d = normalizeDomain(domain)
  if (!d) throw new UserFacingError('domain is empty or invalid')
  let u: URL
  try {
    u = new URL(loginUrl)
  } catch {
    throw new UserFacingError('loginUrl is not a valid URL')
  }
  if (u.protocol !== 'https:') throw new UserFacingError('loginUrl must use https')
  const hosts = [...new Set([...(existing?.hosts ?? []), d, u.hostname.toLowerCase()])]
  return { ...existing, domain: d, hosts, loginUrl, item }
}
