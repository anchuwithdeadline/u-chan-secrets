import { mkdtemp, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { UpdateJournal } from '../src/service/update/journal.js'
import { takeSessionHandoff, writeSessionHandoff } from '../src/service/update/session-handoff.js'
import { BitwardenVault } from '../src/core/vault.js'

const id = { version: '5.1.0', integrity: 'sha512-' + 'a'.repeat(86) + '==' }
const target = { version: '5.1.1', integrity: 'sha512-' + 'b'.repeat(86) + '==' }
async function waitingJob() {
  const journal = new UpdateJournal(await realpath(await mkdtemp(join(tmpdir(), 'ucs-handoff-'))))
  const job = await journal.create(id, target, 1)
  for (const phase of ['verifying', 'staging', 'ready_to_apply', 'switching', 'waiting_for_service'] as const) await journal.transition(job.id, phase)
  return { journal, job }
}
it('hands the session to the next boot once, inside the transaction and before expiry', async () => {
  const { journal, job } = await waitingJob()
  await writeSessionHandoff(journal, job.id, { key: 'k', lastUse: 5 }, 1000)
  expect(await takeSessionHandoff(journal, 2000)).toEqual({ key: 'k', lastUse: 5 })
  expect(await takeSessionHandoff(journal, 2000)).toBeNull()
  await writeSessionHandoff(journal, job.id, { key: 'k', lastUse: 5 }, 1000)
  expect(await takeSessionHandoff(journal, 1000 + 120001)).toBeNull()
  await writeSessionHandoff(journal, job.id, { key: 'k', lastUse: 5 }, 1000)
  await journal.transition(job.id, 'service_ready')
  expect(await takeSessionHandoff(journal, 2000)).toBeNull()
})
it('does not write a locked vault, and the vault refuses an idle-expired session', async () => {
  const { journal, job } = await waitingJob()
  await writeSessionHandoff(journal, job.id, null)
  expect(await takeSessionHandoff(journal)).toBeNull()
  let now = 10_000
  const vault = new BitwardenVault({ dataDir: '.', idleLockMs: 1000, now: () => now, exec: async () => ({ code: 0, stdout: '', stderr: '' }) })
  vault.adoptSession({ key: 'old', lastUse: 0 })
  expect(vault.exportSession()).toBeNull()
  vault.adoptSession({ key: 'fresh', lastUse: 9_500 })
  expect(vault.exportSession()).toEqual({ key: 'fresh', lastUse: 9_500 })
  now = 11_000
  expect(vault.exportSession()).toBeNull()
})
