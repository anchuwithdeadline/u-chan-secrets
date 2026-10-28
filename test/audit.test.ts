import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
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

  it('readTail returns empty array when file does not exist', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'uchan-')), 'nonexistent.log')
    const log = new FileAuditLog(p)
    expect(await log.readTail()).toEqual([])
  })

  it('readTail returns parsed records in order', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'uchan-')), 'audit.log')
    const log = new FileAuditLog(p)
    await log.record({ action: 'login', domain: 'a.com', result: 'ok' })
    await log.record({ action: 'revoke', domain: 'b.com', result: 'removed' })
    await log.record({ action: 'unlock', domain: '', result: 'ok' })
    const records = await log.readTail()
    expect(records).toHaveLength(3)
    expect(records[0]).toMatchObject({ action: 'login', domain: 'a.com', result: 'ok' })
    expect(records[1]).toMatchObject({ action: 'revoke', domain: 'b.com', result: 'removed' })
    expect(records[2]).toMatchObject({ action: 'unlock', domain: '', result: 'ok' })
    expect(typeof records[0].ts).toBe('string')
  })

  it('readTail limits to the last N entries', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'uchan-')), 'audit.log')
    const log = new FileAuditLog(p)
    for (let i = 1; i <= 5; i++) {
      await log.record({ action: 'login', domain: `d${i}.com`, result: 'ok' })
    }
    const records = await log.readTail(2)
    expect(records).toHaveLength(2)
    expect(records[0].domain).toBe('d4.com')
    expect(records[1].domain).toBe('d5.com')
  })

  it('readTail skips blank and corrupted lines', async () => {
    const p = join(mkdtempSync(join(tmpdir(), 'uchan-')), 'audit.log')
    const valid1 = JSON.stringify({ ts: '2026-10-28T00:00:00.000Z', action: 'login', domain: 'a.com', result: 'ok' })
    const valid2 = JSON.stringify({ ts: '2026-10-28T00:01:00.000Z', action: 'unlock', domain: '', result: 'ok' })
    writeFileSync(p, `${valid1}\ncorrupt json\n\n   \n${valid2}\n`)
    const log = new FileAuditLog(p)
    const records = await log.readTail()
    expect(records).toHaveLength(2)
    expect(records[0].domain).toBe('a.com')
    expect(records[1].action).toBe('unlock')
  })
})
