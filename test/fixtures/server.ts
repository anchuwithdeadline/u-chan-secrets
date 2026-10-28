import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { totpCode } from '../../src/core/totp.js'

export const OTP_SEED = 'JBSWY3DPEHPK3PXP'

export interface Fixture { server: Server; port: number; posts: string[]; bounceRoot: boolean; close(): Promise<void> }

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const page = (body: string) => `<!doctype html><html><body>${body}</body></html>`
const singleForm = `<form method="post" action="/single"><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form>`
const stepEmail = (action: string) => `<form method="post" action="${action}"><input type="email" name="email"><button type="submit">Next</button></form>`
const stepPassword = (email: string) =>
  `<form method="post" action="/two-step"><input type="hidden" name="email" value="${esc(email)}"><input type="password" name="password"><button type="submit">Login</button></form>`
const otpLogin = singleForm.replace('/single', '/otp')
// Same shape as authenticationtest.com/totpChallenge: 2FA field inside the password form.
const otpInline = `<form method="post" action="/otp-inline"><input type="email" name="email"><input type="password" name="password"><input type="text" name="totpmfa"><input type="submit" value="Log In"></form>`
const otpForm =`<form method="post" action="/otp-verify"><input name="otp" autocomplete="one-time-code" inputmode="numeric"><button type="submit">Verify</button></form>`

export async function startFixture(): Promise<Fixture> {
  const posts: string[] = []
  let port = 0
  const fxState = { bounceRoot: false }
  const server = createServer((req, res) => {
    const url = req.url ?? '/'
    const send = (html: string) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(page(html)) }
    const redirect = (to: string) => { res.writeHead(302, { location: to, ...(to === '/dash' ? { 'set-cookie': 'sid=1; Path=/' } : {}) }); res.end() }
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
        if (url === '/otp') return send(good ? otpForm : otpLogin)
        if (url === '/otp-inline') {
          const valid = [Date.now(), Date.now() - 30000].map((t) => totpCode(OTP_SEED, t))
          return good && valid.includes(form.get('totpmfa') ?? '') ? redirect('/dash') : send(otpInline)
        }
        if (url === '/otp-verify') {
          const valid = [Date.now(), Date.now() - 30000].map((t) => totpCode(OTP_SEED, t))
          return valid.includes(form.get('otp') ?? '') ? redirect('/dash') : send(otpForm)
        }
        res.writeHead(404); res.end()
      })
      return
    }
    switch (url) {
      case '/single': return send(singleForm)
      case '/two-step': return send(stepEmail('/two-step'))
      case '/already': return redirect('/dash')
      case '/dash': return send('<h1>Dashboard</h1>')
      case '/': return fxState.bounceRoot ? redirect(`http://localhost:${port}/dash`) : send('<p>root</p>')
      case '/redirect-evil': return redirect(`http://localhost:${port}/single`)
      case '/nav-no-fields': return send(`<script>setTimeout(()=>{location.href='http://localhost:${port}/dash'},100)</script>`)
      case '/late':
        return send(`<div id="m"></div><template id="tpl">${singleForm}</template><script>setTimeout(()=>{const t=document.getElementById('tpl');document.getElementById('m').appendChild(t.content.cloneNode(true))},500)</script>`)
      case '/disabled-pass':
        return send(`<form method="post" action="/single"><input type="email" name="email"><input type="password" name="password" disabled><button type="submit">Login</button></form>`)
      case '/nav-evil':
        return send(`<form method="post" action="/single"><input type="email" name="email" oninput="location.href='http://localhost:${port}/single'"><input type="password" name="password"><button type="submit">Login</button></form>`)
      case '/stuck': return send(stepEmail('/stuck'))
      case '/otp': return send(otpLogin)
      case '/otp-inline': return send(otpInline)
      case '/spa-slow':
        // SPA: URL changes at once on submit, the form only goes away later.
        return send(`<form id="f"><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form><script>f.onsubmit=(e)=>{e.preventDefault();history.pushState(null,'','/spa-slow?signing-in');setTimeout(()=>{location.href='/dash'},1200)}</script>`)
      case '/spa-remount': {
        // SPA: submit re-renders the form (old nodes detached), then navigates later.
        const form = `<form><input type="email" name="email"><input type="password" name="password"><button type="submit">Login</button></form>`
        return send(`<div id="m">${form}</div><template id="tpl">${form}</template><script>const m=document.getElementById('m');const tpl=document.getElementById('tpl');m.addEventListener('submit',(e)=>{e.preventDefault();m.replaceChildren(tpl.content.cloneNode(true));setTimeout(()=>{location.href='/dash'},1200)})</script>`)
      }
      case '/captcha':
        return send(`${singleForm}<iframe src="/recaptcha/api2/anchor"></iframe>`)
      case '/recaptcha/api2/anchor': return send('<p>captcha</p>')
      case '/pass-only':
        return send(`<form method="post" action="/single"><input type="password" name="password"><button type="submit">Login</button></form>`)
    }
    res.writeHead(404); res.end()
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  port = (server.address() as AddressInfo).port
  return { server, port, posts, get bounceRoot() { return fxState.bounceRoot }, set bounceRoot(v: boolean) { fxState.bounceRoot = v }, close: () => new Promise<void>((r) => { server.close(() => r()); server.closeAllConnections() }) }
}
