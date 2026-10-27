import child_process from 'node:child_process'

export interface UacStatus {
  enabled: boolean
  consentPromptBehaviorAdmin: number
  promptOnSecureDesktop: boolean
  isDefault: boolean
  warning?: string
}

export const UAC_DEFAULT_WARNING =
  'WARNING: Windows UAC is at the default level (consent prompt on secure desktop).\n' +
  'Normal user processes can silently bypass default UAC to gain administrator rights.\n' +
  'For full protection, set UAC to "Always notify" or run Claude in a standard user account.'

export const UAC_DISABLED_WARNING =
  'WARNING: Windows UAC is disabled.\n' +
  'All processes run with administrative privileges without prompt.'

export const UAC_REG_KEY = 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Policies\\System'

export type RegistryQuery = (key: string, valueName: string) => Promise<number | undefined>

export const defaultRegistryQuery: RegistryQuery = async (
  key: string,
  valueName: string
): Promise<number | undefined> => {
  return new Promise((resolve) => {
    const normalizedKey = key.replace(/^HKLM:\\/i, 'HKLM\\').replace(/\//g, '\\')
    child_process.execFile(
      'reg.exe',
      ['query', normalizedKey, '/v', valueName],
      (error, stdout) => {
        if (error) {
          return resolve(undefined)
        }
        const match = stdout.match(/REG_DWORD\s+(0x[0-9a-fA-F]+|\d+)/i)
        if (!match) {
          return resolve(undefined)
        }
        const raw = match[1]
        const val = raw.toLowerCase().startsWith('0x') ? parseInt(raw, 16) : parseInt(raw, 10)
        resolve(Number.isNaN(val) ? undefined : val)
      }
    )
  })
}

export async function checkUacLevel(queryReg: RegistryQuery = defaultRegistryQuery): Promise<UacStatus> {
  const safeQuery = async (name: string): Promise<number | undefined> => {
    try {
      return await queryReg(UAC_REG_KEY, name)
    } catch {
      return undefined
    }
  }

  const lua = await safeQuery('EnableLUA')
  const consent = await safeQuery('ConsentPromptBehaviorAdmin')
  const secureDesktop = await safeQuery('PromptOnSecureDesktop')

  const enabled = lua === undefined ? true : lua !== 0
  const consentPromptBehaviorAdmin = consent ?? 0
  const promptOnSecureDesktop = secureDesktop === undefined ? true : secureDesktop !== 0

  let isDefault = false
  let warning: string | undefined

  if (!enabled) {
    isDefault = false
    warning = UAC_DISABLED_WARNING
  } else if (consentPromptBehaviorAdmin === 5) {
    isDefault = true
    warning = UAC_DEFAULT_WARNING
  } else if (consentPromptBehaviorAdmin === 2) {
    isDefault = false
    warning = undefined
  }

  return {
    enabled,
    consentPromptBehaviorAdmin,
    promptOnSecureDesktop,
    isDefault,
    warning,
  }
}
