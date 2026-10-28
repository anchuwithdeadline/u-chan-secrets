import { join, posix, win32 } from 'node:path'
import { homedir } from 'node:os'
import { defaultEndpoint } from '../ipc/endpoint.js'

export interface AppConfig {
  chromeProfile: string
  cdpEndpoint: string
}

/** Paths owned by the privileged service. Never read by the MCP client. */
export function serviceConfig(env: NodeJS.ProcessEnv, platform: NodeJS.Platform) {
  const path = platform === 'win32' ? win32 : posix
  const home =
    env.U_CHAN_HOME ??
    (platform === 'win32'
      ? path.join(env.ProgramData ?? 'C:\\ProgramData', 'u-chan-secrets')
      : '/Library/Application Support/u-chan-secrets')
  return {
    home,
    allowlistPath: path.join(home, 'allowlist.json'),
    auditPath: path.join(home, 'audit.log'),
    settingsPath: path.join(home, 'settings.json'),
    bwDataDir: path.join(home, 'bw-data'),
    endpoint: defaultEndpoint(env, platform),
  }
}

/** User-side values only (the user's Chrome). */
export function loadConfig(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): AppConfig {
  const base =
    env.APPDATA ??
    (platform === 'darwin'
      ? join(homedir(), 'Library', 'Application Support')
      : join(homedir(), 'AppData', 'Roaming'))
  const home = env.U_CHAN_HOME ?? join(base, 'u-chan-secrets')
  return {
    chromeProfile: join(home, 'chrome-profile'),
    cdpEndpoint: env.U_CHAN_CDP ?? 'http://127.0.0.1:9222',
  }
}
