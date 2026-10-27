import { describe, expect, it } from 'vitest'
import { parseTotp, totpCode } from '../src/core/totp.js'
import { UserFacingError } from '../src/core/types.js'

// RFC 6238 appendix B seeds (ASCII "1234567890..." repeated), base32-encoded.
const SHA1 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
const SHA256 = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA'
const SHA512 = 'GEZDGNBVGY3TQOJQ'.repeat(6) + 'GEZDGNA'

describe('totpCode', () => {
  it('matches RFC 6238 vectors', () => {
    const at = (s: number) => s * 1000
    expect(totpCode(`otpauth://totp/x?secret=${SHA1}&digits=8`, at(59))).toBe('94287082')
    expect(totpCode(`otpauth://totp/x?secret=${SHA1}&digits=8`, at(1111111109))).toBe('07081804')
    expect(totpCode(`otpauth://totp/x?secret=${SHA256}&digits=8&algorithm=SHA256`, at(59))).toBe('46119246')
    expect(totpCode(`otpauth://totp/x?secret=${SHA512}&digits=8&algorithm=SHA512`, at(20000000000))).toBe('47863826')
  })
  it('accepts a bare base32 secret with spaces and lowercase (6 digits, 30s)', () => {
    expect(totpCode(SHA1.toLowerCase().replace(/(.{4})/g, '$1 '), 59000)).toBe('287082')
  })
  it('honours period', () => {
    expect(parseTotp(`otpauth://totp/x?secret=${SHA1}&period=60`).period).toBe(60)
  })
  it('rejects unusable seeds without echoing them', () => {
    for (const bad of ['', 'not base32!', 'steam://ABCDEF', `otpauth://hotp/x?secret=${SHA1}`, `otpauth://totp/x?secret=${SHA1}&algorithm=MD5`]) {
      let err: unknown
      try { totpCode(bad, 0) } catch (e) { err = e }
      expect(err).toBeInstanceOf(UserFacingError)
      if (bad) expect((err as Error).message).not.toContain(bad)
    }
  })
})
