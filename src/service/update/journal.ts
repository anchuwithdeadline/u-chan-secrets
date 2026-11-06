import { lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname, join, resolve, parse } from 'node:path'
import { randomBytes, randomUUID } from 'node:crypto'
import { idSchema, jobSchema, markerSchema, sameIdentity, terminal, type ObservedIdentity, type ReleaseIdentity, type UpdateJob, type UpdatePhase, type UpdateError } from './protocol.js'

export async function noLinks(path: string): Promise<void> {
  for (let p = resolve(path);;) {
    try { if ((await lstat(p)).isSymbolicLink()) throw new Error('unsafe_update_path') }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (p === parse(p).root) break
    p = dirname(p)
  }
}
export async function boundedJson(path: string, limit = 16384): Promise<unknown> {
  await noLinks(path)
  const stat = await lstat(path)
  if (!stat.isFile() || stat.size > limit) throw new Error('invalid_update_state')
  const bytes = await readFile(path)
  if (bytes.length > limit) throw new Error('invalid_update_state')
  return JSON.parse(bytes.toString('utf8'))
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await noLinks(path)
  const bytes = JSON.stringify(value)
  if (Buffer.byteLength(bytes) > 16384) throw new Error('invalid_update_state')
  const temp = path + '.' + randomUUID() + '.tmp', file = await open(temp, 'wx', 0o600)
  try { await file.writeFile(bytes); await file.sync(); await file.close(); await rename(temp, path) }
  finally { await file.close(); await unlink(temp).catch(() => {}) }
}
const transitions: Record<UpdatePhase, UpdatePhase[]> = {
  checking: ['verifying','failed'], verifying: ['staging','failed'], staging: ['ready_to_apply','failed'],
  ready_to_apply: ['switching','failed'], switching: ['waiting_for_service','rolling_back','failed','recovery_required'],
  waiting_for_service: ['service_ready','rolling_back','recovery_required'], rolling_back: ['rolled_back','recovery_required'],
  service_ready: [], rolled_back: [], failed: [], recovery_required: [],
}
export class UpdateJournal {
  private initialized = false
  private verified = new Set<string>()
  private chain: Promise<unknown> = Promise.resolve()
  readonly root: string
  constructor(readonly home: string, private readonly secure: (path: string) => Promise<void> = async () => {}, private readonly verify: (path: string) => Promise<boolean> = async () => true) { this.root = join(home, 'updates') }
  directory(id: string): string { return join(this.root, idSchema.parse(id)) }
  private async directoryReady(path: string, create = false): Promise<void> {
    await noLinks(path)
    let exists = true
    try { if (!(await lstat(path)).isDirectory()) throw new Error('unsafe_update_path') }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; exists = false }
    if (!exists) { if (!create) throw Object.assign(new Error('update_state_not_found'), { code: 'ENOENT' }); await mkdir(path, { mode: 0o700 }); await this.secure(path) }
    if (!await this.verify(path)) throw new Error('unsafe_update_permissions')
  }
  private async init(create = false): Promise<void> { if (!this.initialized) { await this.directoryReady(this.root, create); this.initialized = true } }
  private async checked(id: string, create = false): Promise<string> {
    await this.init(create)
    const dir = this.directory(id)
    if (!this.verified.has(id)) { await this.directoryReady(dir, create); this.verified.add(id) }
    return dir
  }
  async read(id: string): Promise<UpdateJob> { const dir = await this.checked(id); const job = jobSchema.parse(await boundedJson(join(dir, 'job.json'))); if (job.id !== id) throw new Error('invalid_update_state'); return job }
  async latest(): Promise<UpdateJob | null> {
    let pointer: unknown
    try { await this.init(); pointer = await boundedJson(join(this.root, 'current.json'), 1024) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
    const id = idSchema.parse((pointer as { id?: unknown })?.id)
    return this.read(id)
  }
  async create(source: ObservedIdentity, target: ReleaseIdentity, parentPid: number): Promise<UpdateJob> {
    const operation = async () => {
      await this.init(true)
      if (await this.latest().then(j => j && (!terminal(j.phase)||j.phase==='recovery_required'))) throw new Error('update_busy')
      const job = jobSchema.parse({ id: randomUUID(), phase: 'checking', source, target, parentPid, nonce: randomBytes(32).toString('hex'), createdAt: Date.now(), updatedAt: Date.now() })
      const dir = await this.checked(job.id, true)
      await atomicJson(join(dir, 'job.json'), job)
      await atomicJson(join(this.root, 'current.json'), { id: job.id })
      return job
    }
    const result = this.chain.then(operation, operation); this.chain = result.catch(() => {}); return result
  }
  async transition(id: string, phase: UpdatePhase, error?: UpdateError): Promise<UpdateJob> {
    const job = await this.read(id)
    if (phase !== job.phase && !transitions[job.phase].includes(phase)) throw new Error('invalid_update_transition')
    const next = jobSchema.parse({ ...job, phase, updatedAt: Date.now(), ...(error ? { error } : {}) })
    await atomicJson(join(this.directory(id), 'job.json'), next)
    return next
  }
  async acknowledge(id: string, boot: ObservedIdentity, pid: number): Promise<void> {
    const job = await this.read(id), kind = job.phase === 'waiting_for_service' ? 'target' : job.phase === 'rolling_back' ? 'source' : null
    if (!kind || !sameIdentity(boot, kind === 'target' ? job.target : job.source)) throw new Error('readiness_identity_mismatch')
    await atomicJson(join(this.directory(id), 'ready.json'), markerSchema.parse({ id, nonce: job.nonce, boot, pid, kind }))
  }
  async marker(id: string): Promise<ReturnType<typeof markerSchema.parse> | null> {
    try { return markerSchema.parse(await boundedJson(join(await this.checked(id), 'ready.json'), 4096)) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e }
  }
}
