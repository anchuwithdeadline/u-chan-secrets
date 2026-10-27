import { describe, it, expect } from 'vitest'
import { redact } from '../src/core/redact.js'

describe('redact', () => {
  it('replaces every occurrence', () => {
    expect(redact('pw=hunter2 again hunter2', ['hunter2'])).toBe('pw=[REDACTED] again [REDACTED]')
  })
  it('ignores empty secrets', () => {
    expect(redact('abc', [''])).toBe('abc')
  })
})
