import { describe, it, expect } from 'vitest'
import { readFile, stat } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'

describe('macOS start-chrome.sh script', () => {
  it('exists and has LF line endings with bash shebang', async () => {
    const raw = await readFile('scripts/start-chrome.sh')
    const content = raw.toString('utf8')
    expect(content.startsWith('#!/bin/bash')).toBe(true)
    expect(content).not.toContain('\r\n')
  })

  it('searches for Google Chrome in both /Applications and ~/Applications', async () => {
    const script = await readFile('scripts/start-chrome.sh', 'utf8')
    expect(script).toContain('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(script).toContain('$HOME/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
    expect(script).toContain('exit 1')
  })

  it('checks if CDP port is open before launching Chrome', async () => {
    const script = await readFile('scripts/start-chrome.sh', 'utf8')
    expect(script).toMatch(/PORT=.*\b9222\b/)
    expect(script).toContain('nc -z')
    expect(script).toContain('curl -s')
    expect(script).toContain('exit 0')
  })

  it('sets profile directory using U_CHAN_HOME with macOS default', async () => {
    const script = await readFile('scripts/start-chrome.sh', 'utf8')
    expect(script).toContain('Library/Application Support/u-chan-secrets')
    expect(script).toContain('chrome-profile')
    expect(script).toContain('mkdir -p')
  })

  it('launches Chrome with required flags', async () => {
    const script = await readFile('scripts/start-chrome.sh', 'utf8')
    expect(script).toContain('--remote-debugging-port=')
    expect(script).toContain('--remote-debugging-address=127.0.0.1')
    expect(script).toContain('--user-data-dir=')
    expect(script).toContain('--no-first-run')
  })

  it('passes bash syntax check if bash is available', async () => {
    const check = spawnSync('bash', ['-n', 'scripts/start-chrome.sh'])
    if (!check.error) {
      expect(check.status).toBe(0)
    }
  })
})
