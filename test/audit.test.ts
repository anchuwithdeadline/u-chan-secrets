import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileAuditLog } from '../src/core/audit.js'

describe('FileAuditLog', () => {
  it('appends JSON lines and creates the directory', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'uchan-')), 'sub', 'audit.log')
    const log = new FileAuditLog(p)
    await log.record({ action: 'login', domain: 'a.com', result: 'ok' })
    await log.record({ action: 'revoke', domain: 'b.com', result: 'removed' })
    const lines = readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({ action: 'login', domain: 'a.com', result: 'ok' })
    expect(typeof lines[0].ts).toBe('string')
    expect(lines[1].action).toBe('revoke')
  })
})
