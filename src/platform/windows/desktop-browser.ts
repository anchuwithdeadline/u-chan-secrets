import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import type { DiagnosticState } from '../../core/doctor.js'
import type { BrowserKind } from '../../client/browser-choice.js'

export function inspectDesktopBrowser(options: { endpoint: string; browser: BrowserKind; profile: string }, env: NodeJS.ProcessEnv = process.env): Promise<DiagnosticState> {
  // The shared script derives the dedicated profile from the same user home as loadConfig.
  const expected = options.profile.replace(/[\\/](?:chrome|edge)-profile$/, '')
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../../../scripts/start-browser.ps1', import.meta.url)), '-Browser', options.browser, '-CheckOnly'],
  { env: { ...env, U_CHAN_HOME: expected, U_CHAN_CDP: options.endpoint }, timeout: 15000, windowsHide: true, maxBuffer: 65536 },
  (error, stdout) => resolve(error ? 'unknown' : stdout.trim() === 'pass' ? 'pass' : stdout.trim() === 'fail' ? 'fail' : 'unknown')))
}

export function inspectServiceDesktopBrowser(endpoint: string, ownerSid: string, env: NodeJS.ProcessEnv = process.env, browser?: BrowserKind): Promise<DiagnosticState> {
  if (!/^S-1-5-21-(?:[0-9]+-){3}[0-9]+$/.test(ownerSid)) return Promise.resolve('unknown')
  return new Promise(resolve => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
    fileURLToPath(new URL('../../../scripts/start-browser.ps1', import.meta.url)), '-CheckOnly', '-DesktopOwnerSid', ownerSid, ...(browser ? ['-Browser', browser] : [])],
  { env: { ...env, U_CHAN_CDP: endpoint }, timeout: 15000, windowsHide: true, maxBuffer: 65536 },
  (error, stdout) => resolve(error ? 'unknown' : stdout.trim() === 'pass' ? 'pass' : stdout.trim() === 'fail' ? 'fail' : 'unknown')))
}
