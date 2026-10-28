// Run from a trusted administrator terminal after building and installing the service.
// Exercises SYSTEM relay, desktop entry, restoration and reply transport without a password UI.
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { compileCsharp } from '../dist/platform/windows/assets/compiler.js'
import { PROMPT_HELPER_CSHARP } from '../dist/platform/windows/assets/prompt-src.js'
import { defaultAdminCheck } from '../dist/platform/windows/install.js'
import { setAdminOnlyAcl } from '../dist/platform/windows/acl.js'

if (process.platform !== 'win32' || !await defaultAdminCheck()) throw new Error('Use a trusted Windows administrator terminal')
const home = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'u-chan-secrets')
const root = path.join(home, '#0 backup', 'desktop-probe-' + randomUUID())
const task = 'UChanDesktopProbe-' + randomUUID()
const exec = promisify(execFile)
const powershell = script => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
const quote = value => "'" + value.replaceAll("'", "''") + "'"
let registered = false
try {
  await fs.mkdir(root)
  await setAdminOnlyAcl(root)
  const trace = path.join(root, 'desktop-trace.txt')
  if (!PROMPT_HELPER_CSHARP.includes('return RunDialog(args);') || !PROMPT_HELPER_CSHARP.includes('SwitchDesktop(original);')) throw new Error('Native probe hooks no longer match; no helper was run')
  const source = PROMPT_HELPER_CSHARP
    .replace('return RunDialog(args);', `File.AppendAllText(@"${trace}", "entered"+Environment.NewLine); return 0;`)
    .replace('SwitchDesktop(original);', `if (SwitchDesktop(original)) File.AppendAllText(@"${trace}", "restored"+Environment.NewLine);`)
  const helper = path.join(root, 'probe.exe')
  await compileCsharp(source, helper, { outputType: 'WindowsApplication', referencedAssemblies: ['System.Windows.Forms.dll', 'System.Drawing.dll'] })
  const output = path.join(root, 'result.json'), runner = path.join(root, 'runner.mjs')
  await fs.writeFile(runner, `import{execFile}from'node:child_process';import fs from'node:fs';execFile(${JSON.stringify(helper)},['--mode','confirm','--phrase','DISPOSABLE-NATIVE-PROBE','--lines','[]'],{timeout:35000,windowsHide:true},(e,out)=>fs.writeFileSync(${JSON.stringify(output)},JSON.stringify({exitCode:e?.code??0,stdoutBytes:Buffer.byteLength(out)})));`)
  await setAdminOnlyAcl(root)
  await powershell(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute ${quote(path.join(home, 'bin', 'node.exe'))} -Argument ${quote('"' + runner + '"')};$p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s | Out-Null`)
  registered = true
  await powershell(`Start-ScheduledTask -TaskName ${quote(task)}`)
  const deadline = Date.now() + 60000
  let execution
  while (Date.now() < deadline) {
    try { execution = JSON.parse(await fs.readFile(output, 'utf8')); break }
    catch (e) { if (e.code !== 'ENOENT') throw e }
    await new Promise(resolve => setTimeout(resolve, 500))
  }
  const events = await fs.readFile(trace, 'utf8').catch(() => '')
  const ok = execution?.exitCode === 0 && execution.stdoutBytes === 0 && events.trim() === 'entered\r\nrestored'
  console.log(JSON.stringify({ ok, nativeDryRun: true, desktopEntered: events.includes('entered'), desktopRestored: events.includes('restored'), execution, evidence: root }))
  if (!ok) process.exitCode = 1
} finally {
  if (registered) await powershell(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false`)
}
