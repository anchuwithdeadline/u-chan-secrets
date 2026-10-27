import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

export interface Fixture { server: Server; port: number; posts: string[]; close(): Promise<void> }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const singleForm = `<form method="post" action="/single"><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form>`
const stepEmail = (action: string) => `<form method="post" action="${action}"><input type="email" name="email"><button type="submit">Next</button></form>`
const stepPassword = (email: string) =>
  `<form method="post" action="/two-step"><input type="hidden" name="email" value="${esc(email)}"><input type="password" name="password"><button type="submit">Login</button></form>`

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
        const good = form.get('email') === 'u@x' && form.get('password') === 'pw'
        if (url === '/single') return good ? redirect('/dash') : send(singleForm)
        if (url === '/two-step') {
          if (!form.has('password')) return send(stepPassword(form.get('email') ?? ''))
          return good ? redirect('/dash') : send(stepEmail('/two-step'))
        }
        if (url === '/stuck') return send(stepEmail('/stuck'))
        res.writeHead(404); res.end()
      })
      return
    }
    switch (url) {
      case '/single': return send(singleForm)
      case '/two-step': return send(stepEmail('/two-step'))
      case '/already': return redirect('/dash')
      case '/dash': return send('<h1>Dashboard</h1>')
      case '/redirect-evil': return redirect(`http://localhost:${port}/single`)
      case '/late':
        return send(`<div id="m"></div><script>setTimeout(()=>{document.getElementById('m').innerHTML=${JSON.stringify(singleForm)}},500)</script>`)
      case '/disabled-pass':
        return send(`<form method="post" action="/single"><input type="email" name="email"><input type="password" name="password" disabled><button type="submit">Login</button></form>`)
      case '/nav-evil':
        return send(`<form method="post" action="/single"><input type="email" name="email" oninput="location.href='http://localhost:${port}/single'"><input type="password" name="password"><button type="submit">Login</button></form>`)
      case '/stuck': return send(stepEmail('/stuck'))
      case '/pass-only':
        return send(`<form method="post" action="/single"><input type="password" name="password"><button type="submit">Login</button></form>`)
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  return { server, port, posts, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }) }
}
