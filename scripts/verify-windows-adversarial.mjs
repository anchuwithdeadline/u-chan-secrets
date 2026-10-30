// Two-stage disposable check: --prepare runs non-elevated; --run requires UAC approval.
// No vault is unlocked and no real passwords, keyboard text or screenshots are recorded.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { randomUUID } from 'node:crypto'
import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { compileCsharp } from '../dist/platform/windows/assets/compiler.js'
import { PROMPT_HELPER_CSHARP } from '../dist/platform/windows/assets/prompt-src.js'
import { defaultAdminCheck } from '../dist/platform/windows/install.js'
import { setAdminOnlyAcl } from '../dist/platform/windows/acl.js'
import { accepted } from './windows-security/result-policy.mjs'

if (process.platform !== 'win32') throw new Error('Windows required')
const exec = promisify(execFile), command = process.argv[2], runIdArgument = process.argv[3]
const quote = s => "'" + s.replaceAll("'", "''") + "'"
const ps = script => exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true })
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const publicRoot = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'UChanSecurityChecks')
async function createChannel(runId) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId ?? '')) throw new Error('Fresh run UUID required')
  const directory = path.join(publicRoot, runId)
  const channelScript = await fs.readFile(new URL('./windows-security/public-channel.ps1', import.meta.url), 'utf8')
  await ps('$probePublicRoot=' + quote(publicRoot) + ';$probeRunDirectory=' + quote(directory) + ';' + channelScript)
  return directory
}
async function publishReport(directory, report) {
  const temporaryReport = path.join(directory, 'report.json.tmp')
  await fs.writeFile(temporaryReport, JSON.stringify(report, null, 2), { flag: 'wx' })
  await fs.rename(temporaryReport, path.join(directory, 'report.json'))
}

if (command === '--prepare') {
  if (await defaultAdminCheck()) throw new Error('Prepare must run non-elevated')
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'u-chan-security-'))
  const runId = randomUUID(), prefix = path.join(directory, 'probe'), publicDirectory = path.join(publicRoot, runId), publicPrefix = path.join(publicDirectory, 'probe'), attacker = path.join(directory, 'attacker.exe')
  await compileCsharp(await fs.readFile(new URL('./windows-security/attacker.cs', import.meta.url), 'utf8'), attacker, { outputType: 'WindowsApplication', referencedAssemblies: ['System.Windows.Forms.dll', 'System.Drawing.dll'] })
  const child = spawn(attacker, [publicPrefix, prefix, runId], { windowsHide: true, stdio: 'ignore' })
  let spawnError
  child.once('error', e => { spawnError = e })
  const exited = new Promise(resolve => child.once('exit', resolve))
  const config = { runId, prefix, attackerPid: child.pid, directory, publicDirectory }
  await fs.writeFile(path.join(directory, 'config.json'), JSON.stringify(config))
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError
    if (await fs.stat(prefix + '.armed').catch(() => null)) break
    if (await fs.stat(prefix + '.attacker').catch(() => null)) throw new Error('Attacker positive control failed: ' + await fs.readFile(prefix + '.attacker', 'utf8'))
    await sleep(100)
  }
  if (!await fs.stat(prefix + '.armed').catch(() => null)) throw new Error('Attacker did not arm')
  // Keep the child referenced: run --run <runId> concurrently in a second, elevated terminal.
  console.log(JSON.stringify({ ...config, armed: true, nextCommand: 'node scripts/verify-windows-adversarial.mjs --run ' + runId }))
  await exited
  const nativeReport = path.join(publicDirectory, 'report.json'), reportDeadline = Date.now() + 30000
  while (Date.now() < reportDeadline && !await fs.stat(nativeReport).catch(() => null)) await sleep(100)
  const native = JSON.parse(await fs.readFile(nativeReport, 'utf8'))
  const observed = Object.fromEntries((await fs.readFile(prefix + '.attacker', 'utf8')).trim().split(/\r?\n/).map(line => line.split('=')))
  const report = { ...native, attacker: observed, ok: accepted(native, observed, runId) }
  await fs.writeFile(path.join(directory, 'report.json'), JSON.stringify(report, null, 2))
  console.log(JSON.stringify(report))
  if (!report.ok) process.exitCode = 1
} else if (command === '--run') {
  if (!await defaultAdminCheck()) throw new Error('Run requires administrator privileges')
  const runId = runIdArgument
  // Atomically create a read-public, admin/SYSTEM-write-only channel. Never read or write user-supplied paths while elevated.
  const directory = await createChannel(runId), prefix = path.join(directory, 'probe')
  const home = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'u-chan-secrets')
  const root = path.join(home, '#0 backup', 'adversarial-' + randomUUID())
  const task = 'UChanSecurityProbe-' + randomUUID()
  const report = { ok: false, nativeFixture: true, root, runId }
  let registered = false
  try {
    await fs.mkdir(root); await setAdminOnlyAcl(root)
    const trace = path.join(root, 'trace.txt')
    const metadata = prefix + '.metadata'
    const head = 'public static class PromptHelper\n    {'
    if (!PROMPT_HELPER_CSHARP.includes(head)) throw new Error('Fixture hooks no longer match')
    let source = PROMPT_HELPER_CSHARP.replace(head, head + '\n        private static string ProbeDesktop; private static NamedPipeServerStream ProbeIdlePipe;')
      .replace('desktop = CreateDesktop("UChan-" + Guid.NewGuid().ToString("N"),', 'ProbeDesktop="UChanProbe-"+Guid.NewGuid().ToString("N"); desktop = CreateDesktop(ProbeDesktop,')
      .replace('int remainingSeconds = 120;', 'int remainingSeconds = 4;')
      .replace('SwitchDesktop(original);', `if(SwitchDesktop(original)) File.AppendAllText(@"${trace}", "restored"+Environment.NewLine);`)
    source = source.replace('timer.Start();\n                if (txtPassword != null)', `timer.Start();
                string probePipe="";
                for(int k=0;k+1<args.Length;k++)if(args[k]=="--output-pipe")probePipe=args[k+1];
                File.AppendAllText(@"${trace}", "shown-system:"+WindowsIdentity.GetCurrent().IsSystem+";session:"+Process.GetCurrentProcess().SessionId+Environment.NewLine);
                File.WriteAllLines(@"${metadata}",new string[]{ProbeDesktop,probePipe,form.Handle.ToInt64().ToString(),btnOk.Handle.ToInt64().ToString(),"${runId}",probePipe+"-idle"});
                form.BeginInvoke((Action)delegate { form.Activate();btnOk.Focus();File.AppendAllText(@"${trace}","canary-send-count:"+UChanProbeCanary.Send()+Environment.NewLine); });
                if (txtPassword != null)`)
    source = source.replace('DialogResult result = form.ShowDialog();', `Panel probeMarker=new Panel(); probeMarker.BackColor=Color.FromArgb(1,254,71); probeMarker.Size=new Size(64,64); probeMarker.Location=new Point(0,0); form.Controls.Add(probeMarker); probeMarker.BringToFront();
            form.KeyPreview=true; form.KeyDown+=(sender,eventArgs)=>{if(eventArgs.KeyCode==Keys.F24)File.AppendAllText(@"${trace}","protected-canary-received"+Environment.NewLine);};
            DialogResult result = form.ShowDialog();`)
    source = source.replace('List<string> childArgs = new List<string>(args);', `ProbeIdlePipe=new NamedPipeServerStream(name+"-idle",PipeDirection.In,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security);bool onlySystem=true;int systemRules=0;foreach(PipeAccessRule rule in pipe.GetAccessControl().GetAccessRules(true,true,typeof(SecurityIdentifier))){if(rule.AccessControlType==AccessControlType.Allow){systemRules++;if(rule.IdentityReference.Value!="S-1-5-18")onlySystem=false;}}File.AppendAllText(@"${trace}","pipe-system-only:"+(onlySystem&&systemRules>0)+Environment.NewLine);List<string> childArgs = new List<string>(args);`)
    source += '\n' + await fs.readFile(new URL('./windows-security/canary.cs', import.meta.url), 'utf8')
    if (!source.includes('shown-system:') || source.includes('int remainingSeconds = 120;')) throw new Error('Fixture substitution failed')
    const attacked = path.join(root, 'attacked.exe'), failure = path.join(root, 'failure.exe')
    await compileCsharp(source, attacked, { outputType: 'WindowsApplication', referencedAssemblies: ['System.Windows.Forms.dll', 'System.Drawing.dll'] })
    const failing = PROMPT_HELPER_CSHARP
      .replace('return RunDialog(args);', 'throw new InvalidOperationException("Disposable failure fixture");')
      .replace('SwitchDesktop(original);', `if(SwitchDesktop(original)) File.AppendAllText(@"${trace}","failure-restored"+Environment.NewLine);`)
    await compileCsharp(failing, failure, { outputType: 'WindowsApplication', referencedAssemblies: ['System.Windows.Forms.dll', 'System.Drawing.dll'] })
    const output = path.join(root, 'native-result.json'), runner = path.join(root, 'runner.mjs')
    await fs.writeFile(runner, `import{execFile}from'node:child_process';import fs from'node:fs';import{promisify}from'node:util';const exec=promisify(execFile);const results={};for(const[name,file]of ${JSON.stringify([['attacked', attacked], ['failure', failure]])}){const start=Date.now();try{const r=await exec(file,['--mode','confirm','--title','DISPOSABLE SECURITY TEST - DO NOT INTERACT','--phrase','DISPOSABLE TEST - NO PASSWORD','--lines','[]'],{timeout:20000,windowsHide:true});results[name]={exitCode:0,stdoutBytes:Buffer.byteLength(r.stdout),elapsedMs:Date.now()-start};}catch(e){results[name]={exitCode:e.code,stdoutBytes:Buffer.byteLength(e.stdout??''),elapsedMs:Date.now()-start};}if(name==='attacked')fs.writeFileSync(${JSON.stringify(prefix + '.done')},'done');}fs.writeFileSync(${JSON.stringify(output)},JSON.stringify(results));`)
    await setAdminOnlyAcl(root)
    await ps(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute ${quote(path.join(home, 'bin', 'node.exe'))} -Argument ${quote('"' + runner + '"')} -WorkingDirectory ${quote(root)};$p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 2) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s | Out-Null`)
    registered = true
    await ps(`Start-ScheduledTask -TaskName ${quote(task)}`)
    const deadline = Date.now() + 60000
    while (Date.now() < deadline && !await fs.stat(output).catch(() => null)) await sleep(200)
    report.execution = JSON.parse(await fs.readFile(output, 'utf8'))
    report.events = (await fs.readFile(trace, 'utf8')).trim().split(/\r?\n/)
    report.ok = report.execution.attacked.exitCode === 1 && report.execution.attacked.elapsedMs >= 3500 && report.execution.attacked.stdoutBytes === 0 && report.execution.failure.exitCode === 1 && report.events.some(e => e.startsWith('shown-system:True;session:')) && report.events.includes('protected-canary-received') && report.events.includes('pipe-system-only:True') && report.events.includes('restored') && report.events.includes('failure-restored')
  } catch (e) { report.errorType = e.name; report.errorMessage = String(e.message).slice(0, 300) }
  finally { if (registered) await ps(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false`) }
  await publishReport(directory, report)
  console.log(JSON.stringify(report))
  if (!report.ok) process.exitCode = 1
} else if (command === '--browser') {
  if (!await defaultAdminCheck()) throw new Error('Browser fixture requires administrator privileges')
  const publicDirectory = await createChannel(runIdArgument ?? randomUUID())
  const home = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'u-chan-secrets')
  const root = path.join(home, '#0 backup', 'browser-probe-' + randomUUID()), task = 'UChanBrowserProbe-' + randomUUID()
  const program = process.argv[4] ? path.resolve(process.argv[4]) : path.join(home, 'program'), endpoint = process.argv[5] ?? 'http://127.0.0.1:9222', matrix = process.argv[6] === 'matrix'
  if (program !== path.join(home, 'program') && !program.startsWith(path.resolve(home, '#0 backup') + path.sep)) throw new Error('Candidate must be in protected backup storage')
  const { safeCdpOrigin } = await import('../dist/core/doctor.js')
  if (!safeCdpOrigin(endpoint)) throw new Error('Unsafe fixture endpoint')
  const desktopHome = matrix ? path.resolve(process.argv[7] ?? '') : undefined
  if (matrix && (!desktopHome.startsWith(path.resolve(os.tmpdir(), 'u-chan-v5-matrix-' + runIdArgument) + path.sep) || !['chrome','edge'].includes(path.basename(desktopHome)))) throw new Error('Unsafe disposable desktop home')
  let registered = false
  try {
    await fs.mkdir(root); await setAdminOnlyAcl(root)
    if (matrix) {
      const settings = JSON.parse(await fs.readFile(path.join(home, 'settings.json'), 'utf8'))
      await fs.writeFile(path.join(root, 'matrix-context.json'), JSON.stringify({ desktopHome, ownerSid: settings.authorizedSid }))
    }
    const runner = path.join(root, 'runner.mjs')
    await fs.copyFile(new URL('./windows-security/browser-worker.mjs', import.meta.url), runner)
    await fs.copyFile(new URL('./windows-security/module-audit.ps1', import.meta.url), path.join(root, 'module-audit.ps1'))
    await fs.copyFile(new URL('./windows-security/result-policy.mjs', import.meta.url), path.join(root, 'result-policy.mjs'))
    await setAdminOnlyAcl(root)
    const transcripts = path.join(process.env.USERPROFILE, '.codex', 'sessions')
    await ps(`$ErrorActionPreference='Stop';$a=New-ScheduledTaskAction -Execute ${quote(path.join(home, 'bin', 'node.exe'))} -Argument ${quote('"' + runner + '" "' + root + '" "' + transcripts + '" "' + program + '" "' + endpoint + '"' + (matrix ? ' matrix' : ''))} -WorkingDirectory ${quote(root)};$p=New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest;$s=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries;Register-ScheduledTask -TaskName ${quote(task)} -Action $a -Principal $p -Settings $s | Out-Null`)
    registered = true; await ps(`Start-ScheduledTask -TaskName ${quote(task)}`)
    const output = path.join(root, 'browser-result.json'), deadline = Date.now() + 90000
    while (Date.now() < deadline && !await fs.stat(output).catch(() => null)) await sleep(200)
    const report = JSON.parse(await fs.readFile(output, 'utf8'))
    await publishReport(publicDirectory, { ...report, evidence: root })
    console.log(JSON.stringify({ ...report, evidence: root }))
    if (!report.ok) process.exitCode = 1
  } finally { if (registered) await ps(`Stop-ScheduledTask -TaskName ${quote(task)} -ErrorAction SilentlyContinue;Unregister-ScheduledTask -TaskName ${quote(task)} -Confirm:$false`) }
} else throw new Error('Use concurrent --prepare and --run <runId> terminals, or --browser from an administrator terminal')
