import { describe, expect, it } from 'vitest'
import { DiscordHttp, DiscordHttpError } from '../src/discord/http.js'
describe('Discord HTTP boundary', () => {
  it('uses one fixed origin and refuses redirects without following them', async () => {
    let calls = 0
    const http = new DiscordHttp(async (url, init) => {
      calls++
      expect(url).toBe('https://discord.com/api/v10/guilds/123')
      expect(init?.redirect).toBe('error')
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bot SECRET')
      return new Response('', { status: 302, headers: { location: 'https://evil.test' } })
    })
    await expect(http.request('SECRET', 'GET', '/guilds/123', undefined, AbortSignal.timeout(5000))).rejects.toMatchObject({ outcome: 'failed' })
    expect(calls).toBe(1)
    await expect(http.request('SECRET', 'GET', '//evil.test', undefined, AbortSignal.timeout(5000))).rejects.toThrow()
    expect(calls).toBe(1)
  })
  it('bounds bodies, honors retry delay, and never replays uncertain writes', async () => {
    let calls = 0
    const http = new DiscordHttp(async () => { calls++; throw new Error('SECRET') })
    await expect(http.request('SECRET', 'POST', '/guilds/123/roles', {}, AbortSignal.timeout(5000))).rejects.toMatchObject({ outcome: 'unknown', message: 'Discord write outcome unknown; inspect before retrying' })
    expect(calls).toBe(1)
    const rate = new DiscordHttp(async () => new Response(JSON.stringify({ retry_after: 20 }), { status: 429, headers: { 'retry-after': '20' } }))
    await expect(rate.request('SECRET', 'GET', '/guilds/123', undefined, AbortSignal.timeout(5000))).rejects.toMatchObject({ outcome: 'failed', retryAfter: 20 })
    const big = new DiscordHttp(async () => new Response('x'.repeat(1024 * 1024 + 1)))
    await expect(big.request('SECRET', 'GET', '/guilds/123', undefined, AbortSignal.timeout(5000))).rejects.toBeInstanceOf(DiscordHttpError)
  })
  it('respects a body-only retry_after and does not shorten long server intervals', async () => {
    let calls = 0
    const http = new DiscordHttp(async () => { calls++; return new Response(JSON.stringify({ retry_after: 120 }), { status: 429 }) })
    await expect(http.request('SECRET', 'GET', '/guilds/123', undefined, AbortSignal.timeout(5000))).rejects.toMatchObject({ retryAfter: 120 })
    await expect(http.request('SECRET', 'GET', '/guilds/123', undefined, AbortSignal.timeout(5000))).rejects.toMatchObject({ retryAfter: 120 })
    expect(calls).toBe(1)
    const long = new DiscordHttp(async () => new Response('{}', { status: 429, headers: { 'retry-after': '100000' } }))
    await expect(long.request('SECRET', 'GET', '/guilds/123', undefined, AbortSignal.timeout(5000))).rejects.toMatchObject({ retryAfter: 100000 })
  })
})
