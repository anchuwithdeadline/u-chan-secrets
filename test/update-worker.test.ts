import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { UpdateJournal } from '../src/service/update/journal.js'
import { runUpdateTransaction } from '../src/service/update/worker.js'
import { integrity } from './fixtures/update-release.js'
async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'ucs-worker-'))), j = new UpdateJournal(home)
  const job = await j.create({ version: '2.0.0', integrity: null }, { version: '2.1.0', integrity: integrity(Buffer.from('new')) }, 123)
  for (const p of ['verifying','staging','ready_to_apply','switching'] as const) await j.transition(job.id, p)
  const program = join(home, 'program'), next = join(j.directory(job.id), 'next')
  await mkdir(program); await mkdir(next)
  await writeFile(join(program, 'package.json'), 'old'); await writeFile(join(next, 'package.json'), 'new')
  await writeFile(join(home, 'settings.json'), 'keep')
  return { home, j, job, program }
}
describe('protected update transaction', () => {
  it('retains old program and verifies target readiness without touching settings', async () => {
    const f = await fixture(), calls: string[] = []
    const result = await runUpdateTransaction(f.j, f.job.id, { verify: async () => {}, handoff: async () => { calls.push('handoff') }, stopForRollback: async () => {}, startSource: async () => {}, waitReady: async kind => { calls.push(kind); return true } })
    expect(result.phase).toBe('service_ready')
    expect(calls).toEqual(['handoff','target'])
    expect(await readFile(join(f.program, 'package.json'), 'utf8')).toBe('new')
    expect(await readFile(join(f.home, '#0 backup', 'update-' + f.job.id, 'package.json'), 'utf8')).toBe('old')
    expect(await readFile(join(f.home, 'settings.json'), 'utf8')).toBe('keep')
  })
  it('restores and verifies old service on target failure; reports failed recovery honestly', async () => {
    for (const recovery of [true, false]) {
      const f = await fixture()
      const result = await runUpdateTransaction(f.j, f.job.id, { verify: async () => {}, handoff: async () => {}, stopForRollback: async () => {}, startSource: async () => {}, waitReady: async kind => kind === 'source' && recovery })
      expect(result.phase).toBe(recovery ? 'rolled_back' : 'recovery_required')
      expect(await readFile(join(f.program, 'package.json'), 'utf8')).toBe('old')
    }
  })
  it('leaves active program untouched when permission verification fails', async () => {
    const f = await fixture()
    expect((await runUpdateTransaction(f.j, f.job.id, { verify: async () => { throw new Error('unsafe') }, handoff: async () => { throw new Error('must not run') }, stopForRollback: async () => {}, startSource: async () => {}, waitReady: async () => false })).phase).toBe('failed')
    expect(await readFile(join(f.program, 'package.json'), 'utf8')).toBe('old')
  })
})
