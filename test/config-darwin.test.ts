import { describe, it, expect } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { loadConfig } from '../src/core/config.js'

describe('macOS config resolution', () => {
  it('loadConfig resolves Darwin Library Application Support path', () => {
    const cfg = loadConfig({}, 'darwin')
    const expected = join(homedir(), 'Library', 'Application Support', 'u-chan-secrets', 'chrome-profile')
    expect(cfg.chromeProfile).toBe(expected)
    expect(cfg.cdpEndpoint).toBe('http://127.0.0.1:9222')
  })

  it('loadConfig respects U_CHAN_HOME on Darwin', () => {
    const cfg = loadConfig({ U_CHAN_HOME: '/custom/path' }, 'darwin')
    expect(cfg.chromeProfile).toBe(join('/custom/path', 'chrome-profile'))
  })

  it('loadConfig respects U_CHAN_CDP on Darwin', () => {
    const cfg = loadConfig({ U_CHAN_CDP: 'http://127.0.0.1:9333' }, 'darwin')
    expect(cfg.cdpEndpoint).toBe('http://127.0.0.1:9333')
  })

  it('loadConfig falls back to AppData when APPDATA is explicitly provided', () => {
    const cfg = loadConfig({ APPDATA: '/custom/appdata' }, 'darwin')
    expect(cfg.chromeProfile).toBe(join('/custom/appdata', 'u-chan-secrets', 'chrome-profile'))
  })

  it('defaults to process.platform and process.env when called with no arguments', () => {
    const cfg = loadConfig()
    expect(cfg.chromeProfile).toBeDefined()
    expect(cfg.cdpEndpoint).toBeDefined()
  })
})
