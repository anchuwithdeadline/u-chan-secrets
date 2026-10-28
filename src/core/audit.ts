import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AuditEvent, AuditLog, AuditRecord } from './types.js'

export class FileAuditLog implements AuditLog {
  constructor(private readonly path: string) {}
  async record(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const { action, domain, result } = event
    await appendFile(this.path, JSON.stringify({ ts: new Date().toISOString(), action, domain, result }) + '\n')
  }

  async readTail(limit = 100): Promise<AuditRecord[]> {
    let content: string
    try {
      content = await readFile(this.path, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw e
    }
    const lines = content.split('\n')
    const records: AuditRecord[] = []
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const parsed = JSON.parse(trimmed) as AuditRecord
        if (parsed && typeof parsed === 'object' && typeof parsed.ts === 'string' && typeof parsed.action === 'string') {
          records.push(parsed)
        }
      } catch {
        // skip corrupt line
      }
    }
    return records.slice(-limit)
  }
}
