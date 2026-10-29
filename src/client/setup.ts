import { bounded, safeCdpOrigin, type DiagnosticCheck, type DiagnosticReport } from '../core/doctor.js'
import type { CodexSetupResult, CodexSetupState } from './codex-setup.js'
export interface SetupOptions { apply: boolean; replaceExisting: boolean; startBrowser: boolean }
export interface SetupReport {
  version: 1; state: 'needs_attention' | 'configured'; sharing: 'unobserved' | 'mismatch' | 'process_configured'
  restartRequired: boolean; checks: DiagnosticCheck[]; actions: { id: string; message: string; required: boolean }[]
  client: CodexSetupState; changed: boolean; backupPath?: string
}
export interface SetupDeps {
  platform: NodeJS.Platform; endpoint: string; elevated: () => Promise<boolean>
  doctor: () => Promise<DiagnosticReport>
  configure: (options: Pick<SetupOptions, 'apply' | 'replaceExisting'>) => Promise<CodexSetupResult>
  startBrowser: () => Promise<boolean>
}
export async function runSetup(o: SetupOptions, d: SetupDeps): Promise<SetupReport> {
  const r: SetupReport = { version: 1, state: 'needs_attention', sharing: 'unobserved', restartRequired: false, checks: [], actions: [], client: 'unavailable', changed: false }
  const action = (id: string, message: string, required = true) => r.actions.push({ id, message, required })
  try {
    if (await bounded(d.elevated, true)) { action('configure_mcp', 'Run setup from a non-administrator desktop terminal.'); return r }
    if (!safeCdpOrigin(d.endpoint)) { action('configure_mcp', 'Configure a safe HTTP loopback browser target.'); return r }
    r.checks = (await d.doctor()).checks
    if (d.platform !== 'win32') { action('configure_mcp', 'Automatic setup supports Windows and Codex only; configure other platforms manually.'); r.client = 'manual'; return r }
    if (r.checks.some(c => c.id === 'browser_target' && c.state === 'fail')) {
      r.sharing = 'mismatch'; action('configure_mcp', 'Align the desktop and service loopback browser targets before applying setup.'); return r
    }
    const configured = await d.configure({ apply: o.apply, replaceExisting: o.replaceExisting })
    r.client = configured.state; r.changed = configured.changed; r.backupPath = configured.backupPath
    let attemptedStart = false, started = true
    if (o.startBrowser && !r.checks.some(c => c.id === 'chrome' && c.state === 'pass')) {
      attemptedStart = true; started = await bounded(d.startBrowser, false, 15000)
    }
    if (r.changed || attemptedStart) r.checks = (await d.doctor()).checks
    const pw = r.checks.find(c => c.id === 'playwright')
    const mismatch = r.checks.some(c => c.id === 'browser_target' && c.state === 'fail')
    r.sharing = mismatch || pw?.state === 'fail' ? 'mismatch' : pw?.state === 'pass' ? 'process_configured' : 'unobserved'
    r.restartRequired = r.changed || pw?.state === 'fail'
    const ids: Record<string, string> = { registration: 'install_service', service: 'install_service', ipc: 'install_service',
      version: 'update_service', assets: 'repair_permissions', permissions: 'repair_permissions', service_browser: 'start_browser', chrome: 'start_browser',
      browser_target: 'configure_mcp', playwright: 'configure_mcp', uac: 'review_uac' }
    for (const c of r.checks) if (c.nextAction) {
      const id = c.id === 'vault' ? c.state === 'pass' ? 'unlock_vault' : 'authenticate_vault' : ids[c.id] ?? 'configure_mcp'
      action(id, c.nextAction, c.required && c.state !== 'pass')
    }
    if (r.client !== 'ready') action('configure_mcp', 'Inspect Codex configuration; apply missing registrations explicitly and preserve custom settings.')
    if (!started) action('start_browser', 'Dedicated Chrome did not become reachable; inspect the launcher and run setup again.')
    if (r.restartRequired) action('restart_client', 'Restart the AI session to load saved MCP registrations.', false)
    action('configure_mcp', 'Active AI-session browser ownership is unverified; check the current client browser connection.', false)
    const requiredOk = r.checks.length > 0 && r.checks.filter(c => c.required).every(c => c.state === 'pass')
    if (requiredOk && r.client === 'ready' && started && !mismatch) r.state = 'configured'
    return r
  } catch { action('configure_mcp', 'Setup inspection failed; run u-chan doctor and inspect retained configuration changes.'); return r }
}
export function setupExitCode(r: SetupReport): 0 | 1 | 2 {
  return r.state === 'needs_attention' ? 1 : r.restartRequired ? 2 : 0
}
