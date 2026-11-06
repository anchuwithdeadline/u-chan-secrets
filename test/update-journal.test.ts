import { expect, it } from 'vitest'
import { mkdtemp, realpath, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { UpdateJournal } from '../src/service/update/journal.js'
import { integrity } from './fixtures/update-release.js'

it('status reads do not create update directories or unknown jobs', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ucs-journal-'))), j = new UpdateJournal(root)
  expect(await j.latest()).toBeNull()
  await expect(j.read(randomUUID())).rejects.toThrow()
  expect(await readdir(root)).toEqual([])
})

it('serializes private jobs, rejects conflicting jobs and validates readiness identity', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'ucs-journal-')))
  const j = new UpdateJournal(root)
  const job = await j.create({ version: '2.0.0', integrity: null }, { version: '2.1.0', integrity: integrity(Buffer.from('x')) }, 123)
  expect((await j.latest())?.id).toBe(job.id)
  await expect(j.create(job.source, job.target, 123)).rejects.toThrow('update_busy')
  await expect(j.transition(job.id, 'service_ready')).rejects.toThrow()
  await j.transition(job.id, 'verifying'); await j.transition(job.id, 'staging'); await j.transition(job.id, 'ready_to_apply'); await j.transition(job.id, 'switching'); await j.transition(job.id, 'waiting_for_service')
  await expect(j.acknowledge(job.id, job.source, 999)).rejects.toThrow('readiness_identity_mismatch')
  await j.acknowledge(job.id, job.target, 999)
  expect((await j.marker(job.id))?.nonce).toBe(job.nonce)
  await j.transition(job.id, 'service_ready')
  expect((await j.create(job.source, job.target, 123)).id).not.toBe(job.id)
  await expect(j.read('../escape')).rejects.toThrow()
  await writeFile(join(root, 'updates', 'current.json'), '{bad')
  await expect(j.latest()).rejects.toThrow()
})
