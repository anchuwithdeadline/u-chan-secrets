import { join, posix, win32 } from 'node:path'
import { homedir } from 'node:os'
import { defaultEndpoint } from '../ipc/endpoint.js'
import { browserKind, readBrowserChoice, type BrowserKind } from '../client/browser-choice.js'

export interface AppConfig {
  browser: BrowserKind
  browserProfile: string
  browserChoicePath: string
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
    programDir: path.join(home, 'program'),
    stagingDir: path.join(home, 'staging'),
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
  const browserChoicePath = join(home, 'browser.json')
  const browser = env.U_CHAN_BROWSER === undefined ? readBrowserChoice(browserChoicePath) ?? 'chrome' : browserKind(env.U_CHAN_BROWSER)
  return {
    browser,
    browserProfile: join(home, `${browser}-profile`),
    browserChoicePath,
    chromeProfile: join(home, 'chrome-profile'),
    cdpEndpoint: env.U_CHAN_CDP ?? 'http://127.0.0.1:9222',
  }
}

/** An already-running MCP process must not silently use a selection replaced by later setup. */
export function resolveLoginBrowser(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): BrowserKind {
  const config = loadConfig(env, platform), saved = readBrowserChoice(config.browserChoicePath)
  if (env.U_CHAN_BROWSER !== undefined && saved !== undefined && config.browser !== saved) throw new Error('Browser selection changed; restart the AI session before login.')
  return config.browser
}
