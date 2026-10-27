import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { ApprovalMode } from '../core/types.js'

export interface Settings { mode: ApprovalMode; phrase: string; idleLockMs: number }
const DEFAULTS: Settings = { mode: 'easy', phrase: '', idleLockMs: 43200000 }

export class SettingsStore {
  constructor(private readonly path: string) {}

  async get(): Promise<Settings> {
    let raw: string
    try {
      raw = await readFile(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULTS }
      throw e
    }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  }

  async update(patch: Partial<Settings>): Promise<Settings> {
    const next = { ...(await this.get()), ...patch }
    await mkdir(dirname(this.path), { recursive: true })
    const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`
    await writeFile(tmp, JSON.stringify(next, null, 2))
    await rename(tmp, this.path)
    return next
  }
}
