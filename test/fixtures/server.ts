import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Fixture { server: Server; port: number; posts: string[]; close(): Promise<void> }

const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const singleForm = `<form method="post" action="/single"><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form>`
const stepEmail = `<form method="post" action="/two-step"><input type="email" name="email"><button type="submit">Next</button></form>`
const stepPassword = (email: string) =>
  `<form method="post" action="/two-step"><input type="hidden" name="email" value="${email}"><input type="password" name="password"><button type="submit">Login</button></form>`

export async function startFixture(): Promise<Fixture> {
  const posts: string[] = []
  let port = 0
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (html: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(html)) }
    const redirect = (to: string) => { res.writeHead(302, { location: to }); res.end() }
    if (req.method === 'POST') {
      posts.push(url)
      let raw = ''
      req.on('data', (c) => (raw += c))
      req.on('end', () => {
        const form = new URLSearchParams(raw)
        if (url === '/single') {
          return form.get('email') === 'u@x' && form.get('password') === 'pw' ? redirect('/dash') : send(singleForm)
        }
        if (url === '/two-step') {
          if (!form.has('password')) return send(stepPassword(form.get('email') ?? ''))
          return form.get('email') === 'u@x' && form.get('password') === 'pw' ? redirect('/dash') : send(stepEmail)
        }
        res.writeHead(404); res.end()
      })
      return
    }
    if (url === '/single') return send(singleForm)
    if (url === '/two-step') return send(stepEmail)
    if (url === '/already' || url === '/dash') return url === '/already' ? redirect('/dash') : send('<h1>Dashboard</h1>')
    if (url === '/redirect-evil') return redirect(`http://localhost:${port}/single`)
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  return { server, port, posts, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }) }
}
