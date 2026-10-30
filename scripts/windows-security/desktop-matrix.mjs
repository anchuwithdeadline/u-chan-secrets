// User-side half of the disposable Windows browser matrix. The administrator runs the SYSTEM fixture separately.
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { createServer } from 'node:net'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chromium } from 'playwright'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { isElevated } from '../../dist/client/codex-setup.js'
import { inspectDesktopBrowser } from '../../dist/platform/windows/desktop-browser.js'
const [command, browser, runId] = process.argv.slice(2)
if (process.platform !== 'win32' || command !== '--prepare' || !['chrome','edge'].includes(browser) || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId ?? '')) throw new Error('Use --prepare chrome|edge <fresh UUID> on Windows')
if (await isElevated()) throw new Error('Prepare must run as the non-elevated desktop owner')
const root = path.join(os.tmpdir(), 'u-chan-v5-matrix-' + runId), home = path.join(root, browser)
await fs.mkdir(root) // A fresh UUID must never reuse another fixture or personal profile.
await fs.mkdir(home)
const port = await new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const selected = server.address().port; server.close(() => resolve(selected)) }) })
const endpoint = 'http://127.0.0.1:' + port, environment = { ...process.env, U_CHAN_HOME: home, U_CHAN_CDP: endpoint, U_CHAN_BROWSER: browser }
const report = { runId, browser, ok: false }, exec = promisify(execFile)
let connection
try {
  await exec('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',fileURLToPath(new URL('../start-browser.ps1',import.meta.url)),'-Browser',browser,'-Background'], { env: environment, windowsHide: true, timeout: 30000 })
  report.desktopIdentity = await inspectDesktopBrowser({ endpoint, browser, profile: path.join(home,browser+'-profile') },environment)
  if (report.desktopIdentity !== 'pass') throw new Error('Disposable browser identity failed')
  connection = await chromium.connectOverCDP(endpoint)
  await fs.writeFile(path.join(root,'prepared.json'),JSON.stringify({runId,browser,home,endpoint}),{flag:'wx'})
  console.log(JSON.stringify({prepared:true,runId,browser,endpoint}))
  const receipt = path.join(process.env.ProgramData ?? 'C:\\ProgramData','UChanSecurityChecks',runId,'report.json'), deadline=Date.now()+600000
  while(Date.now()<deadline&&!await fs.stat(receipt).catch(()=>null))await new Promise(resolve=>setTimeout(resolve,500))
  const native = JSON.parse(await fs.readFile(receipt,'utf8'))
  report.systemFixturePassed = native.ok === true && native.fixtureBrowser === browser && native.desktopIdentity === 'pass'
  const client = new Client({name:'u-chan-browser-matrix',version:'1.0.0'})
  const transport = new StdioClientTransport({command:process.execPath,args:[path.join(path.dirname(process.execPath),'node_modules/npm/bin/npx-cli.js'),'@playwright/mcp@latest','--cdp-endpoint',endpoint],stderr:'pipe'})
  try {
    await client.connect(transport)
    report.playwrightTools=(await client.listTools()).tools.length
    report.sharedBrowserListing=!(await client.callTool({name:'browser_tabs',arguments:{action:'list'}})).isError
  } finally {await client.close().catch(()=>{});await transport.close().catch(()=>{})}
  report.ok=report.systemFixturePassed&&report.playwrightTools>0&&report.sharedBrowserListing
}catch(error){report.errorType=error.name}
finally{
  // Only this verified disposable instance may be closed; never enumerate or terminate other browsers.
  if(connection&&await inspectDesktopBrowser({endpoint,browser,profile:path.join(home,browser+'-profile')},environment)==='pass') {
    const session=await connection.newBrowserCDPSession().catch(()=>null)
    await session?.send('Browser.close').catch(()=>{})
  }
  await connection?.close().catch(()=>{})
  await fs.writeFile(path.join(root,'complete.json'),JSON.stringify(report,null,2),{flag:'wx'})
}
console.log(JSON.stringify(report))
if(!report.ok)process.exitCode=1
