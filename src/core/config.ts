import { join } from 'node:path'
import { homedir } from 'node:os'

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  const base = env.APPDATA ?? join(homedir(), 'AppData', 'Roaming')
  const home = env.U_CHAN_HOME ?? join(base, 'u-chan-secrets')
  return {
    home,
    allowlistPath: join(home, 'allowlist.json'),
    auditPath: join(home, 'audit.log'),
    sessionPath: join(home, 'bw-session'),
    chromeProfile: join(home, 'chrome-profile'),
    cdpEndpoint: env.U_CHAN_CDP ?? 'http://127.0.0.1:9222',
  }
}
