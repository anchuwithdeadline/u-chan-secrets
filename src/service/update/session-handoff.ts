import { unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { atomicJson, boundedJson, type UpdateJournal } from './journal.js'

// Keeps the vault unlocked across an update restart only. The session waits in the admin-only
// transaction directory for at most TTL_MS and is deleted on first read; reboots and crashes still lock.
// ponytail: plaintext under SYSTEM/Administrators ACL (an admin can read SYSTEM DPAPI anyway); add DPAPI if offline-disk theft matters.
const TTL_MS = 120000
const FILE = 'session.json'
const handoffSchema = z.object({ key: z.string().min(1).max(1024), lastUse: z.number(), expires: z.number() }).strict()

export async function writeSessionHandoff(journal: UpdateJournal, id: string, session: { key: string; lastUse: number } | null, now = Date.now()): Promise<void> {
  if (!session) return
  if ((await journal.read(id)).phase !== 'waiting_for_service') return
  await atomicJson(join(journal.directory(id), FILE), { ...session, expires: now + TTL_MS })
}

/** Reads and deletes the handoff of the latest transaction; only a restart inside that transaction may adopt it. */
export async function takeSessionHandoff(journal: UpdateJournal, now = Date.now()): Promise<{ key: string; lastUse: number } | null> {
  const job = await journal.latest().catch(() => null)
  if (!job) return null
  const path = join(journal.directory(job.id), FILE)
  let value: unknown
  try { value = await boundedJson(path, 4096) } catch { return null } finally { await unlink(path).catch(() => {}) }
  const parsed = handoffSchema.safeParse(value)
  if (!parsed.success || parsed.data.expires < now || !['waiting_for_service', 'rolling_back'].includes(job.phase)) return null
  return { key: parsed.data.key, lastUse: parsed.data.lastUse }
}
