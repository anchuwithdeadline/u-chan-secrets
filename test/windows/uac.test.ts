import { describe, expect, it, vi } from 'vitest'
import {
  checkUacLevel,
  UAC_DEFAULT_WARNING,
  UAC_DISABLED_WARNING,
  type RegistryQuery,
} from '../../src/platform/windows/uac.js'

describe('checkUacLevel', () => {
  it('detects default UAC level and emits warning', async () => {
    const fakeQuery: RegistryQuery = vi.fn(async (_key: string, valueName: string) => {
      if (valueName === 'ConsentPromptBehaviorAdmin') return 5
      if (valueName === 'EnableLUA') return 1
      if (valueName === 'PromptOnSecureDesktop') return 1
      return undefined
    })

    const status = await checkUacLevel(fakeQuery)
    expect(status.enabled).toBe(true)
    expect(status.consentPromptBehaviorAdmin).toBe(5)
    expect(status.promptOnSecureDesktop).toBe(true)
    expect(status.isDefault).toBe(true)
    expect(status.warning).toBe(UAC_DEFAULT_WARNING)
  })

  it('recognizes high security always notify', async () => {
    const fakeQuery: RegistryQuery = vi.fn(async (_key: string, valueName: string) => {
      if (valueName === 'ConsentPromptBehaviorAdmin') return 2
      if (valueName === 'EnableLUA') return 1
      if (valueName === 'PromptOnSecureDesktop') return 1
      return undefined
    })

    const status = await checkUacLevel(fakeQuery)
    expect(status.enabled).toBe(true)
    expect(status.consentPromptBehaviorAdmin).toBe(2)
    expect(status.promptOnSecureDesktop).toBe(true)
    expect(status.isDefault).toBe(false)
    expect(status.warning).toBeUndefined()
  })

  it('handles disabled UAC', async () => {
    const fakeQuery: RegistryQuery = vi.fn(async (_key: string, valueName: string) => {
      if (valueName === 'ConsentPromptBehaviorAdmin') return 5
      if (valueName === 'EnableLUA') return 0
      if (valueName === 'PromptOnSecureDesktop') return 1
      return undefined
    })

    const status = await checkUacLevel(fakeQuery)
    expect(status.enabled).toBe(false)
    expect(status.isDefault).toBe(false)
    expect(status.warning).toBe(UAC_DISABLED_WARNING)
    expect(status.warning).toMatch(/disabled/i)
  })

  it('handles missing registry keys safely', async () => {
    const fakeQuery: RegistryQuery = vi.fn(async () => undefined)

    const status = await checkUacLevel(fakeQuery)
    expect(status.enabled).toBe(true)
    expect(status.isDefault).toBe(false)
    expect(status.warning).toBeUndefined()
  })

  it('handles queryReg exceptions safely without throwing', async () => {
    const throwingQuery: RegistryQuery = vi.fn(async () => {
      throw new Error('Registry access denied')
    })

    const status = await checkUacLevel(throwingQuery)
    expect(status.enabled).toBe(true)
    expect(status.isDefault).toBe(false)
    expect(status.warning).toBeUndefined()
  })

  it('queries the expected registry key and value names', async () => {
    const queriedValues: string[] = []
    const fakeQuery: RegistryQuery = vi.fn(async (key: string, valueName: string) => {
      expect(key).toContain('Microsoft\\Windows\\CurrentVersion\\Policies\\System')
      queriedValues.push(valueName)
      return 1
    })

    await checkUacLevel(fakeQuery)
    expect(queriedValues).toContain('ConsentPromptBehaviorAdmin')
    expect(queriedValues).toContain('EnableLUA')
    expect(queriedValues).toContain('PromptOnSecureDesktop')
  })
})
