import { describe, expect, it } from 'vitest'
import { loadConfig, serviceConfig } from '../src/core/config.js'

describe('serviceConfig', () => {
  it('uses ProgramData on Windows', () => {
    expect(serviceConfig({ ProgramData: 'C:\\ProgramData' }, 'win32')).toEqual({
      home: 'C:\\ProgramData\\u-chan-secrets',
      allowlistPath: 'C:\\ProgramData\\u-chan-secrets\\allowlist.json',
      auditPath: 'C:\\ProgramData\\u-chan-secrets\\audit.log',
      settingsPath: 'C:\\ProgramData\\u-chan-secrets\\settings.json',
      bwDataDir: 'C:\\ProgramData\\u-chan-secrets\\bw-data',
      endpoint: String.raw`\\.\pipe\u-chan-secrets`,
      programDir: 'C:\\ProgramData\\u-chan-secrets\\program',
      stagingDir: 'C:\\ProgramData\\u-chan-secrets\\staging',
    })
  })
  it('uses /Library/Application Support on macOS', () => {
    const c = serviceConfig({}, 'darwin')
    expect(c.home).toBe('/Library/Application Support/u-chan-secrets')
    expect(c.settingsPath).toBe('/Library/Application Support/u-chan-secrets/settings.json')
    expect(c.endpoint).toBe('/var/run/u-chan-secrets/ipc.sock')
    expect(c.programDir).toBe('/Library/Application Support/u-chan-secrets/program')
    expect(c.stagingDir).toBe('/Library/Application Support/u-chan-secrets/staging')
  })
  it('honours U_CHAN_HOME and U_CHAN_IPC', () => {
    const c = serviceConfig({ U_CHAN_HOME: '/tmp/uc', U_CHAN_IPC: '/tmp/uc.sock' }, 'darwin')
    expect(c.home).toBe('/tmp/uc')
    expect(c.endpoint).toBe('/tmp/uc.sock')
  })
})

describe('loadConfig', () => {
  it('keeps only the user-side values', () => {
    expect(Object.keys(loadConfig({ APPDATA: 'C:\\A' })).sort()).toEqual(['cdpEndpoint', 'chromeProfile'])
  })
})
