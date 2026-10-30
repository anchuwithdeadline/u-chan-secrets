import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, writeFile, rm, realpath, mkdir, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
import { configureWindowsCommand } from '../src/client/windows-command.js'

const directories: string[] = []
const ps = '#!/usr/bin/env pwsh\n& "node" "$basedir/node_modules/u-chan-secrets/dist/cli.js" $args\nexit $ret\n'
const cmd = '@set "dp0=%~dp0"\r\n@node "%dp0%\\node_modules\\u-chan-secrets\\dist\\cli.js" %*\r\n'
async function fixture() {
  const dir = await realpath(await mkdtemp(join(tmpdir(), 'ucs-command-')))
  directories.push(dir)
  await writeFile(join(dir, 'u-chan.ps1'), ps)
  await writeFile(join(dir, 'u-chan.cmd'), cmd)
  return dir
}
afterEach(async () => { for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('previews without mutation, backs up the shim on apply, and is idempotent', async () => {
  const dir = await fixture()
  expect(await configureWindowsCommand(false, dir)).toMatchObject({ ready: false, changed: false })
  expect(await readFile(join(dir, 'u-chan.ps1'), 'utf8')).toBe(ps)
  const result = await configureWindowsCommand(true, dir)
  expect(result).toMatchObject({ ready: true, changed: true })
  expect(await readFile(result.backupPath!, 'utf8')).toBe(ps)
  await expect(lstat(join(dir, 'u-chan.ps1'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(join(dir, 'u-chan.cmd'), 'utf8')).toBe(cmd)
  expect(await configureWindowsCommand(true, dir)).toMatchObject({ ready: true, changed: false })
})

it('preserves custom launchers and refuses an unavailable batch fallback', async () => {
  const dir = await fixture()
  await writeFile(join(dir, 'u-chan.ps1'), 'Write-Output custom')
  expect(await configureWindowsCommand(true, dir)).toMatchObject({ ready: false, changed: false })
  expect(await readFile(join(dir, 'u-chan.ps1'), 'utf8')).toBe('Write-Output custom')
  await writeFile(join(dir, 'u-chan.ps1'), ps)
  await rm(join(dir, 'u-chan.cmd'))
  expect(await configureWindowsCommand(true, dir)).toMatchObject({ ready: false, changed: false })
  expect(await readFile(join(dir, 'u-chan.ps1'), 'utf8')).toBe(ps)
  expect(await configureWindowsCommand(true, '')).toMatchObject({ ready: true, changed: false })
})

it('runs the short command in a fresh restricted PowerShell without a profile or alias', async () => {
  if (process.platform !== 'win32') return
  const dir = await fixture(), target = join(dir, 'node_modules', 'u-chan-secrets', 'dist')
  await mkdir(target, { recursive: true })
  await writeFile(join(target, 'cli.js'), 'console.log(JSON.stringify(process.argv.slice(2)))')
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Restricted', '-Command', 'u-chan unlock']
  const options = { env: { ...process.env, PATH: dir + ';' + process.env.PATH }, windowsHide: true, timeout: 10000, stdio: 'pipe' as const }
  expect(() => execFileSync('powershell.exe', args, options)).toThrow()
  expect((await configureWindowsCommand(true, dir)).ready).toBe(true)
  expect(execFileSync('powershell.exe', args, options).toString().trim()).toBe('["unlock"]')
})
