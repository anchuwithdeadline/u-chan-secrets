import { expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { inspectServiceDesktopBrowser } from '../../src/platform/windows/desktop-browser.js'
const exec = promisify(execFile)
it('fails closed for unavailable installed-owner metadata without launching a browser', async () => {
  expect(await inspectServiceDesktopBrowser('http://127.0.0.1:9222', 'not-a-sid')).toBe('unknown')
  if (process.platform === 'win32') expect(await inspectServiceDesktopBrowser('http://127.0.0.1:9222', 'S-1-5-21-0-0-0-0')).toBe('unknown')
})
it('validates real launcher process policy without accepting occupied ports as browser proof', async () => {
  if (process.platform !== 'win32') return
  const executable = 'C:\\Browsers\\msedge.exe', profile = 'C:\\Profiles\\edge-profile', owner = 'S-1-5-21-test'
  const good = { ExecutablePath: executable, OwnerSid: owner, CommandLine: `"${executable}" --user-data-dir="${profile}" --remote-debugging-port=9222`, Addresses: ['127.0.0.1'] }
  const cases = [good, { ...good, ExecutablePath: 'C:\\Browsers\\chrome.exe' }, { ...good, OwnerSid: 'other' },
    { ...good, CommandLine: good.CommandLine.replace('edge-profile', 'Default') }, { ...good, CommandLine: null },
    { ...good, CommandLine: good.CommandLine + ` --user-data-dir="${profile}"` }, { ...good, Addresses: ['0.0.0.0'] },
    { ...good, Addresses: ['::'] }, { ...good, Addresses: ['::1'] }, { ...good, OwnerSid: null },
    { ...good, CommandLine: good.CommandLine.replace('=9222', '=9333') }, { ...good, CommandLine: good.CommandLine + ' --remote-debugging-port=9333' },
    { ...good, CommandLine: `"${executable}" --some-option="ignored --user-data-dir=${profile} " --remote-debugging-port=9222` },
    { ...good, CommandLine: `"${executable}" --user-data-dir "${profile}" --remote-debugging-port=9222` }]
  const scriptPath = fileURLToPath(new URL('../../scripts/desktop-browser.ps1', import.meta.url)).replaceAll("'", "''")
  const payload = Buffer.from(JSON.stringify(cases)).toString('base64')
  const script = `$ErrorActionPreference='Stop';. '${scriptPath}';$cases=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}'))|ConvertFrom-Json;$results=@(foreach($case in $cases){Test-UChanBrowserProcess $case '${executable}' '${profile}' '${owner}' 9222});ConvertTo-Json -Compress -InputObject $results`
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { timeout: 10000, windowsHide: true }).catch(error => { throw new Error(String(error.stderr)) })
  expect(JSON.parse(result.stdout)).toEqual(['pass', 'fail', 'fail', 'fail', 'unknown', 'fail', 'fail', 'fail', 'pass', 'unknown', 'fail', 'fail', 'fail', 'fail'])
}, 15000)

it('refuses a real unrelated listener without creating a profile or launching another browser', async () => {
  if (process.platform !== 'win32') return
  const server = createServer(), home = await mkdtemp(join(tmpdir(), 'ucs-port-refusal-'))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      fileURLToPath(new URL('../../scripts/start-browser.ps1', import.meta.url)), '-Browser', 'edge', '-CheckOnly'],
    { env: { ...process.env, U_CHAN_HOME: home, U_CHAN_CDP: `http://127.0.0.1:${port}` }, timeout: 15000, windowsHide: true })
    expect(result.stdout.trim()).toBe('fail')
    expect(await readdir(home)).toEqual([])
    expect(server.listening).toBe(true)
  } finally { server.close(); await rm(home, { recursive: true, force: true }) }
}, 20000)
