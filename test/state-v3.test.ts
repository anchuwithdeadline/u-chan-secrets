import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureV3State, assertCompatibleState } from '../src/service/state.js'
const dirs: string[] = []
afterEach(async () => { for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true }) })
it('backs up protected state before marking V3 and refuses supported V2 downgrade', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ucs-state-')); dirs.push(home)
  await writeFile(join(home, 'allowlist.json'), '[{"legacy":true}]')
  await ensureV3State(home, async () => {})
  expect(await readFile(join(home, '#0 backup', 'v2-before-v3', 'allowlist.json'), 'utf8')).toBe('[{"legacy":true}]')
  await writeFile(join(home, 'allowlist.json'), '[]')
  await ensureV3State(home, async () => {})
  expect(await readFile(join(home, '#0 backup', 'v2-before-v3', 'allowlist.json'), 'utf8')).toBe('[{"legacy":true}]')
  await expect(assertCompatibleState(home, 2)).rejects.toThrow(/downgrade/)
  await expect(assertCompatibleState(home, 3)).resolves.toBeUndefined()
})
it('refuses to use an incomplete backup or write after protection fails', async () => {
  const home = await mkdtemp(join(tmpdir(), 'ucs-state-')); dirs.push(home)
  await mkdir(join(home, '#0 backup', 'v2-before-v3'), { recursive: true })
  await expect(ensureV3State(home, async () => {})).rejects.toThrow(/incomplete/)
  await expect(readFile(join(home, 'schema.json'))).rejects.toThrow()
})
