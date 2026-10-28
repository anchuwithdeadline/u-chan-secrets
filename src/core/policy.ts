import type { AllowOptions } from './types.js'
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
export function validOptions(v: unknown): v is AllowOptions {
  if (!object(v) || Object.keys(v).some(k => k !== 'grant' && k !== 'success')) return false
  if (v.grant !== undefined) {
    const g = v.grant
    if (!object(g)) return false
    if (g.kind === 'timed') {
      if (Object.keys(g).some(k => k !== 'kind' && k !== 'minutes') || !Number.isInteger(g.minutes) || (g.minutes as number) < 1 || (g.minutes as number) > 1440) return false
    } else if ((g.kind !== 'once' && g.kind !== 'permanent') || Object.keys(g).length !== 1) return false
  }
  if (v.success !== undefined) {
    const s = v.success
    if (!object(s) || Object.keys(s).length !== 1) return false
    if ('url' in s) {
      if (typeof s.url !== 'string' || s.url.length > 2048) return false
      try { const u = new URL(s.url); if (u.protocol !== 'https:' || u.username || u.password) return false } catch { return false }
    } else if (typeof s.selector !== 'string' || !s.selector.trim() || s.selector.length > 1000) return false
  }
  return true
}
