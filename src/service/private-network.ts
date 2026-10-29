import type { BrowserContext } from 'playwright'

/** The private browser must not send credential-bearing traffic outside the approved hosts. */
export async function restrictPrivateNetwork(context: BrowserContext, hostCheck: (url: string) => boolean, signal: AbortSignal): Promise<() => boolean> {
  let blocked = false
  const allowed = (url: string) => { try { return !signal.aborted && hostCheck(url) } catch { return false } }
  await context.route('**/*', async route => {
    if (!allowed(route.request().url())) { blocked = true; await route.abort().catch(() => {}); return }
    try {
      // Fetch no redirects: fulfilling a 3xx lets the browser create a new intercepted request.
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout: 10000 })
      const location = response.headers().location
      if (location && response.status() >= 300 && response.status() < 400 && !allowed(new URL(location, route.request().url()).href)) {
        blocked = true; await route.abort().catch(() => {}); return
      }
      if (signal.aborted) { await route.abort().catch(() => {}); return }
      await route.fulfill({ response })
    } catch { await route.abort().catch(() => {}) }
  })
  await context.routeWebSocket('**/*', socket => {
    const url = socket.url().replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
    if (allowed(url)) socket.connectToServer()
    else { blocked = true; void socket.close({ code: 1008, reason: 'Unapproved host' }).catch(() => {}) }
  })
  return () => blocked
}
