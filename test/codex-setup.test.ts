import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { configureCodex } from '../src/client/codex-setup.js'
const dirs: string[] = []
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }) })
async function fixture(entries: Record<string, any> = {}) {
  const configDir = await mkdtemp(join(tmpdir(), 'ucs-codex-')); dirs.push(configDir)
  const original = '# unrelated fixture\n[other]\nvalue = "SECRET_SENTINEL"\n'
  await writeFile(join(configDir, 'config.toml'), original)
  const calls: string[][] = []
  let mutations = 0, failAt = 0
  const options = { apply: false, replaceExisting: false, endpoint: 'http://127.0.0.1:9222', nodePath: 'C:\\Node\\node.exe', entryPath: 'C:\\U Chan\\dist\\index.js', configDir }
  const deps = { elevated: async () => false, exec: async (args: string[]) => {
    calls.push(args)
    const [mcp, action, name] = args
    expect(mcp).toBe('mcp')
    if (action === 'get') return entries[name] ? { code: 0, stdout: JSON.stringify(entries[name]), stderr: '' } : { code: 1, stdout: '', stderr: `WARNING: disposable fixture warning\nError: No MCP server named '${name}' found.` }
    mutations++
    if (mutations === failAt) return { code: 1, stdout: '', stderr: 'SECRET_SENTINEL' }
    // Simulate the official CLI preserving unrelated configuration, including concurrent edits.
    await writeFile(join(configDir, 'config.toml'), original + '# concurrent change\n')
    return { code: 0, stdout: '', stderr: '' }
  } }
  return { options, deps, calls, original, failAt: (n: number) => { failAt = n } }
}
function entry(command: string, args: string[]) {
  return { name: 'fixture', enabled: true, disabled_reason: null, transport: { type: 'stdio', command, args, env: null, env_vars: [], cwd: null }, enabled_tools: null, disabled_tools: null, startup_timeout_sec: null, tool_timeout_sec: null }
}
it('inspects missing entries without writing files or configuration', async () => {
  const f = await fixture()
  expect(await configureCodex(f.options, f.deps)).toMatchObject({ state: 'missing', changed: false })
  expect(f.calls.every(c => c[1] === 'get')).toBe(true)
  expect(await readdir(f.options.configDir)).toEqual(['config.toml'])
})
it('backs up bytes before adding missing entries using argument arrays', async () => {
  const f = await fixture()
  const result = await configureCodex({ ...f.options, apply: true }, f.deps)
  expect(result).toMatchObject({ state: 'ready', changed: true })
  expect(await readFile(result.backupPath!, 'utf8')).toBe(f.original)
  expect(f.calls).toContainEqual(['mcp', 'add', 'u_chan_secrets', '--', f.options.nodePath, f.options.entryPath])
  expect(f.calls).toContainEqual(['mcp', 'add', 'playwright', '--', 'npx', '@playwright/mcp@latest', '--cdp-endpoint', f.options.endpoint])
  expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')
  expect(JSON.stringify(f.calls)).not.toContain('SECRET_SENTINEL')
})
it('requires replacement permission for simple mismatches and preserves custom settings', async () => {
  const plain = entry('node', ['old/index.js'])
  const f = await fixture({ u_chan_secrets: plain })
  expect(await configureCodex({ ...f.options, apply: true }, f.deps)).toMatchObject({ state: 'needs_update', changed: false })
  for (const custom of [{ ...plain, enabled: false }, { ...plain, tool_timeout_sec: 90 }, { ...plain, unknown: 'SECRET_SENTINEL' }, { ...plain, transport: { ...plain.transport, env: { KEY: 'SECRET_SENTINEL' } } }]) {
    const g = await fixture({ u_chan_secrets: custom })
    const result = await configureCodex({ ...g.options, apply: true, replaceExisting: true }, g.deps)
    expect(result).toMatchObject({ state: 'manual', changed: false })
    expect(g.calls.every(c => c[1] === 'get')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')
  }
})
it('retains successful partial changes without restoring an obsolete whole config', async () => {
  const f = await fixture(); f.failAt(2)
  const result = await configureCodex({ ...f.options, apply: true }, f.deps)
  expect(result).toMatchObject({ state: 'unavailable', changed: true })
  expect(await readFile(join(f.options.configDir, 'config.toml'), 'utf8')).toBe(f.original + '# concurrent change\n')
  expect(JSON.stringify(result)).not.toContain('SECRET_SENTINEL')
})
it('refuses elevated execution and unsafe endpoints before invoking Codex', async () => {
  const f = await fixture()
  expect(await configureCodex(f.options, { ...f.deps, elevated: async () => true })).toMatchObject({ state: 'unavailable', changed: false })
  expect(await configureCodex({ ...f.options, endpoint: 'http://user:SECRET_SENTINEL@127.0.0.1:9222' }, f.deps)).toMatchObject({ state: 'manual', changed: false })
  expect(f.calls).toEqual([])
})
it('leaves matching entries alone and replaces only recognized simple entries', async () => {
  const f = await fixture({ u_chan_secrets: entry('node', ['old/index.js']) })
  const result = await configureCodex({ ...f.options, apply: true, replaceExisting: true }, f.deps)
  expect(result).toMatchObject({ state: 'ready', changed: true })
  expect(f.calls).toContainEqual(['mcp', 'remove', 'u_chan_secrets'])
  const g = await fixture({ u_chan_secrets: entry(f.options.nodePath, [f.options.entryPath]), playwright: entry('npx', ['@playwright/mcp@latest', '--cdp-endpoint', f.options.endpoint]) })
  expect(await configureCodex({ ...g.options, apply: true }, g.deps)).toMatchObject({ state: 'ready', changed: false })
  expect(g.calls.every(c => c[1] === 'get')).toBe(true)
})
it('refuses a redirected backup directory without mutating configuration', async () => {
  const f = await fixture(), elsewhere = await mkdtemp(join(tmpdir(), 'ucs-backup-')); dirs.push(elsewhere)
  await symlink(elsewhere, join(f.options.configDir, '#0 backup'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(await configureCodex({ ...f.options, apply: true }, f.deps)).toMatchObject({ state: 'unavailable', changed: false })
  expect(f.calls.every(c => c[1] === 'get')).toBe(true)
  expect(await readdir(elsewhere)).toEqual([])
})
it('preserves compatible enabled custom environment and timeout settings without losing readiness', async () => {
  const f = await fixture()
  const matching = entry(f.options.nodePath, [f.options.entryPath])
  const playwright = entry('npx', ['@playwright/mcp@latest','--cdp-endpoint',f.options.endpoint])
  const g = await fixture({ u_chan_secrets: { ...matching, tool_timeout_sec: 90, transport: { ...matching.transport, env: { KEY: 'SECRET_SENTINEL' } } }, playwright })
  const r = await configureCodex({ ...g.options, apply: true, replaceExisting: true }, g.deps)
  expect(r).toMatchObject({ state: 'ready', changed: false })
  expect(g.calls.every(c => c[1] === 'get')).toBe(true)
  expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL')
})
it('preserves but does not mark ready custom environment that changes browser or service targets', async () => {
  const f = await fixture()
  for (const env of [{ U_CHAN_CDP: 'http://127.0.0.1:9223' }, { U_CHAN_IPC: 'SECRET_SENTINEL' }]) {
    const current = entry(f.options.nodePath, [f.options.entryPath])
    const g = await fixture({ u_chan_secrets: { ...current, transport: { ...current.transport, env } } })
    const r = await configureCodex({ ...g.options, apply: true, replaceExisting: true }, g.deps)
    expect(r).toMatchObject({ state: 'manual', changed: false })
    expect(JSON.stringify(r)).not.toContain('SECRET_SENTINEL')
    expect(g.calls.every(c => c[1] === 'get')).toBe(true)
  }
})
