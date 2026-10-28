import { buildEntry, clean, normalizeDomain } from '../core/allowlist.js'
import { validOptions } from '../core/policy.js'
import type { AllowOptions } from '../core/types.js'
function https(value: string): boolean {
  if (value.length > 2048 || clean(value) !== value) return false
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password } catch { return false }
}
export function parseAllowArgs(args: string[]): { domain: string; loginUrl: string; item: string; options: AllowOptions } | null {
  const [domain, ...flags] = args
  if (!domain || domain.length > 253 || clean(domain) !== domain || /[@:/\\?#\s]/.test(domain) || !normalizeDomain(domain)) return null
  const seen = new Set<string>(), values = new Map<string, string>()
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i]
    if (seen.has(flag) || !['--login-url','--item','--once','--permanent','--minutes','--success-url','--success-selector'].includes(flag)) return null
    seen.add(flag)
    if (flag === '--once' || flag === '--permanent') continue
    const value = flags[++i]
    if (!value || value.startsWith('--') || clean(value) !== value) return null
    values.set(flag, value)
  }
  const loginUrl = values.get('--login-url'), item = values.get('--item')
  if (!loginUrl || !https(loginUrl) || !item?.trim() || item.length > 1000) return null
  if (['--once','--permanent','--minutes'].filter(f => seen.has(f)).length > 1) return null
  if (seen.has('--success-url') && seen.has('--success-selector')) return null
  const options: AllowOptions = { grant: { kind: 'once' } }
  if (seen.has('--permanent')) options.grant = { kind: 'permanent' }
  if (seen.has('--minutes')) {
    const raw = values.get('--minutes')!
    if (!/^[1-9]\d{0,3}$/.test(raw)) return null
    options.grant = { kind: 'timed', minutes: Number(raw) }
  }
  if (seen.has('--success-url')) {
    const url = values.get('--success-url')!
    if (!https(url)) return null
    options.success = { url }
  }
  if (seen.has('--success-selector')) options.success = { selector: values.get('--success-selector')!.trim() }
  if (!validOptions(options)) return null
  try { const entry = buildEntry(domain, loginUrl, item); return { domain: entry.domain, loginUrl, item, options } } catch { return null }
}
