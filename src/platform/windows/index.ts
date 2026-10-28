import fs from 'node:fs'
import path from 'node:path'
import type { PlatformAdapters } from '../index.js'
import { defaultProgramData } from './install.js'
import { WindowsProtectedPrompt } from './prompt.js'
import { createWindowsAuthorizer } from './authorize.js'

export interface WindowsPlatformOptions {
  home?: string
  settingsPath?: string
  binDir?: string
}

export function windowsPlatformAdapters(cfg: WindowsPlatformOptions = {}): PlatformAdapters {
  const programData = cfg.home ?? defaultProgramData()
  const settingsPath = cfg.settingsPath ?? path.join(programData, 'settings.json')
  const binDir = cfg.binDir ?? path.join(programData, 'bin')

  let phrase = ''
  let authorizedSid = ''

  try {
    if (fs.existsSync(settingsPath)) {
      const raw = fs.readFileSync(settingsPath, 'utf8')
      const parsed = JSON.parse(raw)
      phrase = parsed.phrase ?? ''
      authorizedSid = parsed.authorizedSid ?? ''
    }
  } catch {}

  const promptExePath = path.join(binDir, 'prompt-helper.exe')
  const authExePath = path.join(binDir, 'auth-helper.exe')

  const prompt = new WindowsProtectedPrompt({ phrase, promptExePath })
  const authorize = createWindowsAuthorizer({ authorizedSid, authExePath })

  return { prompt, authorize }
}
