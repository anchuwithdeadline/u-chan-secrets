// SYSTEM-only disposable browser fixture. Random credentials stay in this process's memory.
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { moduleAuditSucceeded } from './result-policy.mjs'
const exec = promisify(execFile), root = path.resolve(process.argv[2])
const home = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'u-chan-secrets')
if (!root.startsWith(path.resolve(home, '#0 backup') + path.sep)) throw new Error('Unsafe fixture path')
const program = process.argv[4] ? path.resolve(process.argv[4]) : path.join(home, 'program')
if (program !== path.join(home, 'program') && !program.startsWith(path.resolve(home, '#0 backup') + path.sep)) throw new Error('Unsafe candidate path')
const endpoint = process.argv[5] ?? 'http://127.0.0.1:9222', matrix = process.argv[6] === 'matrix'
const result = { ok: false }, started = Date.now()
const load = relative => import(pathToFileURL(path.join(program, relative)).href)
const { stdout: identity } = await exec('whoami.exe', ['/user'], { windowsHide: true })
if (!identity.includes('S-1-5-18')) throw new Error('SYSTEM runner required')
const username = randomUUID() + '@example.invalid', password = randomUUID() + randomUUID(), cookie = 'u_chan_probe_' + randomUUID().replaceAll('-', '')
let server, shared, userPage, browser, provider, bitwarden, bwTimer
let receivedCredentials = false
let sharedInputCount = 0
let matrixMetadata
try {
  const { chromium } = await load('node_modules/playwright/index.mjs')
  const { IsolatedLogin } = await load('dist/service/isolated-login.js')
  const { CdpBrowserProvider, CdpSessionTarget } = await load('dist/core/browser.js')
  const { privateBrowserPath } = await load('dist/platform/runtime-assets.js')
  const form = '<!doctype html><title>U-Chan disposable security fixture</title><form method="post" action="/login"><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form>'
  server = createServer((req, res) => {
    if (req.method === 'POST') {
      let body = ''; req.on('data', part => { body += part }); req.on('end', () => {
        const fields = new URLSearchParams(body)
        receivedCredentials = fields.get('email') === username && fields.get('password') === password
        res.writeHead(303, { location: '/account', 'set-cookie': cookie + '=fixture; Path=/; HttpOnly; SameSite=Lax' }); res.end()
      }); return
    }
    res.writeHead(200, { 'content-type': 'text/html' })
    res.end(req.url === '/account' && req.headers.cookie?.includes(cookie + '=fixture') ? '<h1 id="signed-in">Disposable signed-in fixture</h1>' : form)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port
  shared = await chromium.connectOverCDP(endpoint)
  if (matrix) {
    const binding = '__uChanMatrixInput' + randomUUID().replaceAll('-', '')
    await shared.contexts()[0].exposeBinding(binding, () => { sharedInputCount++ })
    await shared.contexts()[0].addInitScript(name => document.addEventListener('input', () => { void window[name]().catch(() => {}) }, true), binding)
    const { inspectServiceDesktopBrowser } = await load('dist/platform/windows/desktop-browser.js')
    matrixMetadata = JSON.parse(await fs.readFile(path.join(root, 'matrix-context.json'), 'utf8'))
    const { observeCdpBrowser } = await load('dist/core/doctor.js')
    result.fixtureBrowser = await observeCdpBrowser(endpoint)
    result.desktopIdentity = await inspectServiceDesktopBrowser(endpoint, matrixMetadata.ownerSid, { ...process.env, U_CHAN_DESKTOP_HOME: matrixMetadata.desktopHome }, result.fixtureBrowser)
    result.wrongBrowserRejected = await inspectServiceDesktopBrowser(endpoint, matrixMetadata.ownerSid, { ...process.env, U_CHAN_DESKTOP_HOME: matrixMetadata.desktopHome }, result.fixtureBrowser === 'edge' ? 'chrome' : 'edge') !== 'pass'
  }
  userPage = await shared.contexts()[0].newPage()
  await userPage.addInitScript(() => { window.__uChanProbeInputCount = 0; document.addEventListener('input', () => { window.__uChanProbeInputCount++ }, true) })
  await userPage.goto(origin)
  await userPage.locator('input[type=email]').fill('positive-control@example.invalid')
  result.initScriptPositiveControl = await userPage.evaluate(() => window.__uChanProbeInputCount > 0)
  if (matrix) { await new Promise(resolve => setTimeout(resolve, 150)); result.allPageInputPositiveControl = sharedInputCount > 0; sharedInputCount = 0 }
  await userPage.goto(origin)
  browser = await chromium.launch({ headless: true, executablePath: await privateBrowserPath(home), args: ['--disable-http2', '--disable-quic'] })
  provider = new CdpBrowserProvider(endpoint, matrixMetadata ? { validate: async requested => {
    const { inspectServiceDesktopBrowser } = await load('dist/platform/windows/desktop-browser.js')
    return await inspectServiceDesktopBrowser(endpoint, matrixMetadata.ownerSid, { ...process.env, U_CHAN_DESKTOP_HOME: matrixMetadata.desktopHome }, requested) === 'pass'
  } } : {})
  const target = new CdpSessionTarget(provider, { hostCheck: (_entry, url) => new URL(url).hostname === '127.0.0.1' })
  const login = new IsolatedLogin({ launch: async () => browser, target, timeoutMs: 15000, hostCheck: url => new URL(url).hostname === '127.0.0.1' })
  const outcome = await login.run({ domain: '127.0.0.1', hosts: ['127.0.0.1'], item: 'disposable', loginUrl: origin + '/login', success: { selector: '#signed-in' } }, async () => ({ username, password }), { browser: result.fixtureBrowser ?? 'chrome' })
  result.confirmedFixtureLogin = outcome.status === 'logged_in' && receivedCredentials
  result.sharedInputEvents = matrix ? sharedInputCount : await userPage.evaluate(() => window.__uChanProbeInputCount)
  await userPage.goto(origin + '/account')
  result.transferredFixtureSession = await userPage.locator('#signed-in').isVisible()
  const { CoreService } = await load('dist/core/service.js')
  const { AllowlistStore } = await load('dist/core/allowlist.js')
  const { GrantCoordinator } = await load('dist/service/grants.js')
  const grantPath = path.join(root, 'fixture-grants.json'), store = new AllowlistStore(grantPath)
  const once = { domain: '127.0.0.1', hosts: ['127.0.0.1'], item: 'disposable', loginUrl: origin + '/login', success: { selector: '#signed-in' }, grantId: randomUUID(), remainingUses: 1 }
  await store.upsert(once)
  let credentialReads = 0
  const deps = { vault: { status: async () => 'unlocked', getLogin: async () => { credentialReads++; return { username, password } } }, allowlist: store, approver: { ask: async () => false }, audit: { record: async () => {} }, login, mode: async () => 'easy' }
  const core = new CoreService(deps), attempts = await Promise.all([core.login(once.domain, result.fixtureBrowser ?? 'chrome'), core.login(once.domain, result.fixtureBrowser ?? 'chrome')])
  const restarted = new CoreService({ ...deps, allowlist: new AllowlistStore(grantPath) })
  const replay = await restarted.login(once.domain, result.fixtureBrowser ?? 'chrome')
  result.onceGrantConcurrency = attempts.filter(r => r.ok).length === 1 && attempts.filter(r => r.code === 'grant_exhausted').length === 1 && credentialReads === 1 && replay.code === 'grant_exhausted'
  let wall = Date.now(), mono = 0
  const timed = { ...once, grantId: randomUUID(), remainingUses: undefined, expiresAt: new Date(wall + 60000).toISOString() }
  await store.upsert(timed)
  const clock = new GrantCoordinator(store, { now: () => wall, monotonic: () => mono })
  wall -= 5000; mono += 1000
  await clock.run(async () => {})
  result.clockRollbackPersisted = (await new AllowlistStore(grantPath).get(timed.domain)).expiresAt === new Date(0).toISOString()
  if (matrix) {
    const { createPrivateNetwork } = await load('dist/service/private-network.js')
    const network = await createPrivateNetwork(url => new URL(url).protocol === 'https:' && new URL(url).hostname === 'example.com', AbortSignal.timeout(20000))
    const context = await browser.newContext({ serviceWorkers: 'block', proxy: network.proxy })
    try {
      const page = await context.newPage()
      await page.goto('https://example.com/', { waitUntil: 'domcontentloaded', timeout: 15000 })
      result.privateHttpsCertificateValidated = await page.locator('h1').filter({ hasText: 'Example Domain' }).isVisible()
    } finally { await context.close(); await network.close() }
  }
  await fs.mkdir(path.join(root, 'bw-fixture'))
  bitwarden = spawn(path.join(home, 'bin', 'bw.exe'), ['status'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, BITWARDENCLI_APPDATA_DIR: path.join(root, 'bw-fixture'), BW_NOINTERACTION: 'true' } })
  const bwFinished = new Promise(resolve => bitwarden.once('exit', resolve))
  bwTimer = setTimeout(() => bitwarden.kill(), 15000)
  const body = await fs.readFile(new URL('./module-audit.ps1', import.meta.url), 'utf8')
  const encodedHome = Buffer.from(home, 'utf8').toString('base64')
  const script = '$auditProcessId=' + process.pid + ';$auditServiceHome=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String(' + JSON.stringify(encodedHome) + '));\n' + body
  const audit = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { windowsHide: true, timeout: 20000 })
  result.nativeModules = JSON.parse(audit.stdout)
  await bwFinished; clearTimeout(bwTimer)
  let scanned = 0, matches = 0
  for (const file of [path.join(home, 'audit.log'), path.join(home, 'service.log')]) {
    const text = await fs.readFile(file, 'utf8').catch(() => '')
    if (text) { scanned++; if (text.includes(password) || text.includes(username)) matches++ }
  }
  // SYSTEM's USERPROFILE differs; the trusted administrator passes the desktop transcript directory.
  for (const session of process.argv[3] ? [process.argv[3]] : []) {
    for (const file of await fs.readdir(session, { recursive: true }).catch(() => [])) {
      if (!file.endsWith('.jsonl')) continue
      const full = path.join(session, file), stat = await fs.stat(full).catch(() => null)
      if (!stat || stat.mtimeMs < started || stat.size > 100 * 1024 * 1024) continue
      const text = await fs.readFile(full, 'utf8'); scanned++; if (text.includes(password) || text.includes(username)) matches++
    }
  }
  result.testSecretScan = { artifacts: scanned, matches }
  const { NpmPackageVerifier } = await load('dist/service/update/verifier.js')
  const { ServiceUpdater } = await load('dist/service/update/updater.js')
  const verifier = new NpmPackageVerifier(), verified = await verifier.verify('3.0.2')
  result.realRegistryVerification = verified.ok
  if (verified.ok) {
    const updateHome = path.join(root, 'update-fixture'), programDir = path.join(updateHome, 'program')
    await fs.mkdir(path.join(programDir, 'node_modules'), { recursive: true })
    const pkg = JSON.parse(await fs.readFile(path.join(program, 'package.json'), 'utf8'))
    await fs.writeFile(path.join(programDir, 'package.json'), JSON.stringify({ ...pkg, version: '3.0.1' }))
    await fs.writeFile(path.join(programDir, 'node_modules', 'private-marker'), 'preserve-private-dependencies')
    const state = JSON.stringify({ protectedFixture: randomUUID() })
    await fs.writeFile(path.join(updateHome, 'settings.json'), state)
    let restarts = 0
    const update = new ServiceUpdater({ programDir, stagingDir: path.join(updateHome, 'staging'), currentVersion: '3.0.1', verifier: { checkLatest: async () => ({ isNewer: true, latestVersion: '3.0.2' }), verify: async () => verified }, restarter: { restart: async () => { restarts++ } } })
    const updated = await update.update()
    await new Promise(resolve => setImmediate(resolve))
    result.signedUpdateRehearsal = updated.ok && JSON.parse(await fs.readFile(path.join(programDir, 'package.json'), 'utf8')).version === '3.0.2' && await fs.readFile(path.join(programDir, 'node_modules', 'private-marker'), 'utf8') === 'preserve-private-dependencies' && await fs.readFile(path.join(updateHome, 'settings.json'), 'utf8') === state && restarts === 1
  }
  result.ok = result.initScriptPositiveControl && result.confirmedFixtureLogin && result.sharedInputEvents === 0 && result.transferredFixtureSession && result.onceGrantConcurrency && result.clockRollbackPersisted && moduleAuditSucceeded(result.nativeModules) && result.realRegistryVerification && result.signedUpdateRehearsal && matches === 0
  if (matrix) result.ok &&= result.allPageInputPositiveControl && result.desktopIdentity === 'pass' && result.wrongBrowserRejected && result.privateHttpsCertificateValidated && ['chrome','edge'].includes(result.fixtureBrowser)
} catch (e) { result.errorType = e.name }
finally {
  clearTimeout(bwTimer); if (bitwarden && bitwarden.exitCode === null) bitwarden.kill()
  if (shared) await shared.contexts()[0].clearCookies({ name: cookie }).catch(() => {})
  await userPage?.close().catch(() => {}); await provider?.disconnect().catch(() => {}); await browser?.close().catch(() => {}); await shared?.close().catch(() => {})
  if (server) await new Promise(resolve => { server.close(resolve); server.closeAllConnections() })
}
await fs.writeFile(path.join(root, 'browser-result.json'), JSON.stringify(result, null, 2))
