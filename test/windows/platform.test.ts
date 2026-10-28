import { describe, expect, it } from 'vitest'
import { platformAdapters } from '../../src/platform/index.js'
import { UserFacingError } from '../../src/core/types.js'

describe('platformAdapters', () => {
  it('platformAdapters(win32) returns prompt and authorize adapters without throwing', () => {
    const adapters = platformAdapters('win32')
    expect(adapters).toBeDefined()
    expect(adapters.prompt).toBeDefined()
    expect(adapters.authorize).toBeDefined()
  })

  it('platformAdapters throws UserFacingError for unsupported platforms', () => {
    expect(() => platformAdapters('darwin')).toThrow(UserFacingError)
    expect(() => platformAdapters('darwin')).toThrow(/not supported on darwin yet/)

    expect(() => platformAdapters('linux')).toThrow(UserFacingError)
    expect(() => platformAdapters('linux')).toThrow(/not supported on linux yet/)
  })
})
