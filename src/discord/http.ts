import { abortable } from '../core/abort.js'

export class DiscordHttpError extends Error {
  constructor(message: string, public readonly outcome: 'failed' | 'unknown', public readonly retryAfter?: number) { super(message) }
}
export type DiscordFetch = (url: string, init: RequestInit) => Promise<Response>
async function bodyJson(response: Response, signal: AbortSignal): Promise<unknown> {
  let bytes = 0
  const chunks: Uint8Array[] = []
  const reader = response.body?.getReader()
  try {
    if (!reader || Number(response.headers.get('content-length')) > 1024 * 1024) throw new Error()
    for (;;) {
      const { done, value } = await abortable(reader.read(), signal)
      if (done) break
      bytes += value.byteLength
      if (bytes > 1024 * 1024) throw new Error()
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } finally { await reader?.cancel().catch(() => {}) }
}
export class DiscordHttp {
  private blockedUntil = 0
  constructor(private readonly fetcher: DiscordFetch = fetch) {}
  async request(token: string, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', path: string, body: unknown, signal: AbortSignal): Promise<unknown> {
    if (!/^\/(guilds|channels|users)\/[A-Za-z0-9/@_-]+$/.test(path)) throw new DiscordHttpError('invalid Discord route', 'failed')
    signal.throwIfAborted()
    if (Date.now() < this.blockedUntil) throw new DiscordHttpError('Discord rate limited; retry later', 'failed', Math.ceil((this.blockedUntil - Date.now()) / 1000))
    const write = method !== 'GET'
    let response: Response
    try {
      response = await abortable(this.fetcher(`https://discord.com/api/v10${path}`, {
        method, redirect: 'error', signal,
        headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json', 'User-Agent': 'U-Chan-Secrets (https://github.com/anchuwithdeadline/u-chan-secrets)' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }), signal)
    } catch { throw new DiscordHttpError(write ? 'Discord write outcome unknown; inspect before retrying' : 'Discord request failed', write ? 'unknown' : 'failed') }
    const delay = (v: unknown): number => (typeof v === 'string' || typeof v === 'number') && Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : 0
    if (response.status === 429) {
      // Never replay a write automatically, including a rate-limited write.
      let body: unknown
      try { body = await bodyJson(response, signal) } catch {}
      const retry = Math.max(delay(response.headers.get('retry-after')), delay(response.headers.get('x-ratelimit-reset-after')), body && typeof body === 'object' ? delay((body as Record<string, unknown>).retry_after) : 0) || 60
      this.blockedUntil = Date.now() + retry * 1000
      throw new DiscordHttpError('Discord rate limited; retry later', 'failed', retry)
    }
    if (response.headers.get('x-ratelimit-remaining') === '0') this.blockedUntil = Date.now() + (delay(response.headers.get('x-ratelimit-reset-after')) || 1) * 1000
    if (!response.ok) {
      await response.body?.cancel().catch(() => {})
      throw new DiscordHttpError(write && response.status >= 500 ? 'Discord write outcome unknown; inspect before retrying' : `Discord request rejected (HTTP ${response.status})`, write && response.status >= 500 ? 'unknown' : 'failed')
    }
    if (response.status === 204) return null
    try {
      return await bodyJson(response, signal)
    } catch { throw new DiscordHttpError(write ? 'Discord write outcome unknown; inspect before retrying' : 'Discord response unavailable or too large', write ? 'unknown' : 'failed') }
  }
}
