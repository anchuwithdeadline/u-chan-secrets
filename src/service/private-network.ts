import { createServer, request as httpRequest, type OutgoingHttpHeaders } from 'node:http'
import { connect, type Socket } from 'node:net'

/** Per-context HTTP/CONNECT proxy: every redirect and child target must obtain a separately checked destination. */
export async function createPrivateNetwork(hostCheck: (url: string) => boolean, signal: AbortSignal, loopbackHttpOriginForTesting?: string) {
  let blocked = false, closing: Promise<void> | undefined
  const testOrigin = loopbackHttpOriginForTesting ? new URL(loopbackHttpOriginForTesting) : undefined
  if (testOrigin && (testOrigin.protocol !== 'http:' || testOrigin.hostname !== '127.0.0.1' || testOrigin.username || testOrigin.password)) throw new Error('Invalid loopback fixture origin')
  const sockets = new Set<Socket>()
  const allowed = (url: URL) => {
    try { return !signal.aborted && !url.username && !url.password && hostCheck(url.href) } catch { return false }
  }
  const track = (socket: Socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); socket.on('error', () => {}); socket.setTimeout(60000, () => socket.destroy()) }
  const server = createServer((incoming, response) => {
    let url: URL
    try { url = new URL(incoming.url ?? '') } catch { blocked = true; response.writeHead(403); response.end(); return }
    if (!testOrigin || url.protocol !== 'http:' || url.origin !== testOrigin.origin || !allowed(url)) { blocked = true; response.writeHead(403); response.end(); return }
    const headers: OutgoingHttpHeaders = { ...incoming.headers, host: testOrigin.host }
    delete headers['proxy-authorization']; delete headers['proxy-connection']
    // Plain HTTP exists only for explicitly injected loopback fixtures; the production path uses approved HTTPS CONNECT.
    const outgoing = httpRequest({ hostname: '127.0.0.1', port: Number(testOrigin.port || 80), path: url.pathname + url.search, method: incoming.method, headers, agent: false }, upstream => {
      response.writeHead(upstream.statusCode ?? 502, upstream.headers)
      upstream.pipe(response)
    })
    outgoing.on('socket', track)
    outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end() })
    incoming.on('error', () => outgoing.destroy())
    incoming.pipe(outgoing) // No redirect following or credential buffering in the proxy.
  })
  server.on('connection', socket => { track(socket); if (sockets.size > 128) socket.destroy() })
  server.on('clientError', (_error, socket) => socket.destroy())
  server.on('upgrade', (_request, socket) => { blocked = true; socket.destroy() }) // Production permits WSS via checked CONNECT only.
  server.on('connect', (incoming, connection, head) => {
    const client = connection as Socket
    let url: URL
    try { url = new URL('https://' + incoming.url) } catch { blocked = true; client.destroy(); return }
    if (url.pathname !== '/' || url.search || url.hash || !allowed(url)) { blocked = true; client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return }
    const upstream = connect({ host: url.hostname.replace(/^\[|\]$/g, ''), port: Number(url.port || 443) })
    track(upstream)
    upstream.once('connect', () => {
      if (signal.aborted || client.destroyed) { upstream.destroy(); return }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      upstream.pipe(client); client.pipe(upstream)
    })
    upstream.once('error', () => client.destroy())
    client.once('close', () => upstream.destroy())
  })
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve() }) })
  const close = () => closing ??= new Promise<void>(resolve => { signal.removeEventListener('abort', abort); for (const socket of sockets) socket.destroy(); server.close(() => resolve()) })
  const abort = () => { void close() }
  signal.addEventListener('abort', abort, { once: true })
  if (signal.aborted) await close()
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Private network unavailable')
  return { proxy: { server: `http://127.0.0.1:${address.port}`, bypass: '<-loopback>' }, wasBlocked: () => blocked, close }
}
