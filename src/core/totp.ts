import { createHmac } from 'node:crypto'
import { UserFacingError } from './types.js'

export interface TotpParams { key: Buffer; algorithm: 'sha1' | 'sha256' | 'sha512'; digits: number; period: number }

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
// Fixed message only: the seed must never reach the AI.
const BAD = 'TOTP trong item Bitwarden không dùng được'

function base32(s: string): Buffer {
  const clean = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (!clean) throw new UserFacingError(BAD)
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const c of clean) {
    const i = B32.indexOf(c)
    if (i < 0) throw new UserFacingError(BAD)
    value = (value << 5) | i
    bits += 5
    if (bits >= 8) {
      bits -= 8
      out.push((value >>> bits) & 0xff)
    }
  }
  return Buffer.from(out)
}

/** Parses a Bitwarden `login.totp` value: a bare base32 secret or an `otpauth://totp/` URI. */
export function parseTotp(seed: string): TotpParams {
  const s = String(seed ?? '').trim()
  if (!/^otpauth:/i.test(s)) {
    if (s.includes('://')) throw new UserFacingError(BAD) // e.g. steam://
    return { key: base32(s), algorithm: 'sha1', digits: 6, period: 30 }
  }
  let url: URL
  try { url = new URL(s) } catch { throw new UserFacingError(BAD) }
  if (url.hostname.toLowerCase() !== 'totp') throw new UserFacingError(BAD)
  const q = url.searchParams
  const algorithm = (q.get('algorithm') ?? 'SHA1').toLowerCase()
  if (algorithm !== 'sha1' && algorithm !== 'sha256' && algorithm !== 'sha512') throw new UserFacingError(BAD)
  const digits = Number(q.get('digits') ?? 6)
  const period = Number(q.get('period') ?? 30)
  if (!Number.isInteger(digits) || digits < 6 || digits > 10) throw new UserFacingError(BAD)
  if (!Number.isInteger(period) || period < 1) throw new UserFacingError(BAD)
  return { key: base32(q.get('secret') ?? ''), algorithm, digits, period }
}

/** RFC 6238 code for `seed` at `now` (ms). */
export function totpCode(seed: string, now = Date.now()): string {
  const p = parseTotp(seed)
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(now / 1000 / p.period)))
  const h = createHmac(p.algorithm, p.key).update(counter).digest()
  const o = h[h.length - 1] & 0x0f
  const n = (h.readUInt32BE(o) & 0x7fffffff) % 10 ** p.digits
  return String(n).padStart(p.digits, '0')
}

/** Code that stays valid for at least `minMs`, waiting for the next period if needed. */
export async function freshTotpCode(seed: string, minMs = 3000): Promise<string> {
  const { period } = parseTotp(seed)
  const left = period * 1000 - (Date.now() % (period * 1000))
  if (left < minMs) await new Promise((r) => setTimeout(r, left + 50))
  return totpCode(seed)
}
