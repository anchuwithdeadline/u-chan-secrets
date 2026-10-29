// Non-destructive checks. Run as the ordinary desktop user, never as administrator.
import fs from 'node:fs/promises'
import net from 'node:net'
import path from 'node:path'
import { defaultAdminCheck } from '../dist/platform/windows/install.js'
import { IpcClient } from '../dist/ipc/client.js'
import { defaultEndpoint } from '../dist/ipc/endpoint.js'
import { FrameReader } from '../dist/ipc/protocol.js'

if (process.platform !== 'win32' || await defaultAdminCheck()) throw new Error('Run from a non-elevated Windows terminal')
const home = path.join(process.env.ProgramData ?? 'C:\\ProgramData', 'u-chan-secrets')
const targets = ['settings.json', 'allowlist.json', 'audit.log', 'bin/node.exe', 'bin/bw.exe', 'bin/prompt-helper.exe', 'bin/service-host.exe', 'bin/service-target.txt', 'program/package.json', 'program/dist/service/main.js', 'bin/browser/chrome.exe']
const files = []
for (const target of targets) {
  const item = { target, readDenied: false, writeDenied: false }
  for (const [flag, key] of [['r', 'readDenied'], ['r+', 'writeDenied']]) {
    try { const handle = await fs.open(path.join(home, target), flag); await handle.close() }
    catch (e) { if (e.code === 'EACCES' || e.code === 'EPERM') item[key] = true; else item[key + 'Error'] = e.code }
  }
  files.push(item)
}
let protectedDirectoryDenied = false
try { await fs.opendir(path.join(home, 'bw-data')).then(d => d.close()) }
catch (e) { protectedDirectoryDenied = e.code === 'EACCES' || e.code === 'EPERM' }
const endpoint = defaultEndpoint(process.env, process.platform)
const client = new IpcClient(endpoint, { timeoutMs: 10000 })
const before = await client.listAllowed()
if (!before.ok) throw new Error('Cannot establish grant baseline')
const options = [
  { grant: { kind: 'timed', minutes: 0 } }, { grant: { kind: 'timed', minutes: 1441 } },
  { grant: { kind: 'timed', minutes: 1.5 } }, { grant: { kind: 'once', remainingUses: 100 } },
  { grant: { kind: 'permanent', expiresAt: 'never' } }, { success: { url: 'http://example.invalid/' } },
  { success: { url: 'https://user:password@example.invalid/' } }, { success: { selector: '' } },
  { grant: { kind: 'other' } }, { bypassApproval: true },
]
async function raw(params) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(endpoint), reader = new FrameReader()
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('Invalid request did not fail promptly')) }, 3000)
    const finish = r => { clearTimeout(timer); socket.destroy(); resolve(r) }
    socket.on('connect', () => socket.write(JSON.stringify({ id: 1, method: 'request_allow', params }) + '\n'))
    socket.on('data', chunk => { for (const frame of reader.push(chunk)) finish(frame) })
    socket.on('error', e => { clearTimeout(timer); reject(e) })
  })
}
let malformedRequestsDenied = 0
for (const value of options) {
  const r = await raw({ domain: 'v3-verification.invalid', loginUrl: 'https://v3-verification.invalid/', item: 'DISPOSABLE-INVALID-REQUEST', options: value })
  if (r.ok !== false || r.message !== 'bad request') throw new Error('Malformed policy reached approval or mutation')
  malformedRequestsDenied++
}
const after = await client.listAllowed()
const grantsUnchanged = after.ok && before.message === after.message
const ok = files.every(f => f.readDenied && f.writeDenied) && protectedDirectoryDenied && grantsUnchanged
console.log(JSON.stringify({ ok, nonElevated: true, files, protectedDirectoryDenied, malformedRequestsDenied, grantsUnchanged }))
if (!ok) process.exitCode = 1
