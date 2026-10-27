import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AuditEvent, AuditLog } from './types.js'

export class FileAuditLog implements AuditLog {
  constructor(private readonly path: string) {}
  async record(event: AuditEvent): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const { action, domain, result } = event
    await appendFile(this.path, JSON.stringify({ ts: new Date().toISOString(), action, domain, result }) + '\n')
  }
}
