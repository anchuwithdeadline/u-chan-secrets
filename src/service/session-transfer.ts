import type { BrowserContext } from 'playwright'

export type SessionState = Awaited<ReturnType<BrowserContext['storageState']>>

/** Keeps only cookies and origins that belong to the entry's hosts. */
export function filterState(state: SessionState, hosts: string[]): SessionState {
  const cookies = state.cookies.filter((c) => {
    const d = c.domain.replace(/^\./, '')
    return hosts.some((h) => h === d || h.endsWith('.' + d))
  })
  const origins = state.origins.filter((o) => {
    try {
      return hosts.includes(new URL(o.origin).hostname)
    } catch {
      return false
    }
  })
  return { cookies, origins }
}
