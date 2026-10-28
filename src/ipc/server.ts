import net from 'node:net'
import type { ApprovalMode, ControlApi, CoreApi, Selectors, ToolResult } from '../core/types.js'
import { FrameReader, FrameTooLarge, encode, type Method, type Response } from './protocol.js'

type Api = CoreApi & ControlApi
type Params = Record<string, unknown>
const BAD = Symbol('bad')

const str = (v: unknown): v is string => typeof v === 'string'
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const SELECTOR_KEYS = ['username', 'password', 'submit', 'otp']
const selectorsOf = (v: unknown): Selectors | undefined | typeof BAD => {
  if (v === undefined) return undefined
  if (!isObj(v)) return BAD
  for (const [k, x] of Object.entries(v)) if (!SELECTOR_KEYS.includes(k) || !str(x)) return BAD
  return v as Selectors
}

const handlers: Record<Method, (api: Api, p: Params) => Promise<ToolResult> | typeof BAD> = {
  login: (api, p) => (str(p.domain) ? api.login(p.domain) : BAD),
  request_allow: (api, p) => {
    const sel = selectorsOf(p.selectors)
    if (sel === BAD || !str(p.domain) || !str(p.loginUrl) || !str(p.item)) return BAD
    return api.requestAllow(p.domain, p.loginUrl, p.item, sel)
  },
  revoke: (api, p) => (str(p.domain) ? api.revoke(p.domain) : BAD),
  list_allowed: api => api.listAllowed(),
  status: api => api.status(),
  unlock: api => api.unlock(),
  lock: api => api.lock(),
  set_mode: (api, p) => (p.mode === 'easy' || p.mode === 'hardcore' ? api.setMode(p.mode as ApprovalMode) : BAD),
  import_v1: (api, p) => (Array.isArray(p.entries) ? api.importV1(p.entries) : BAD),
  audit: (api, p) => {
    if (p.limit !== undefined && (!Number.isInteger(p.limit) || (p.limit as number) <= 0)) return BAD
    return api.audit(p.limit as number | undefined)
  },
  update: api => api.update(),
}

async function dispatch(api: Api, msg: unknown): Promise<Response> {
  if (!isObj(msg) || !Number.isInteger(msg.id) || !str(msg.method) || !isObj(msg.params)) {
    return { id: 0, ok: false, message: 'bad request' }
  }
  const id = msg.id as number
  if (!Object.hasOwn(handlers, msg.method)) return { id, ok: false, message: 'unknown method' }
  try {
    const r = handlers[msg.method as Method](api, msg.params)
    if (r === BAD) return { id, ok: false, message: 'bad request' }
    const { ok, message } = await r
    return { id, ok, message }
  } catch {
    return { id, ok: false, message: 'internal error' }
  }
}

export function startIpcServer(
  path: string,
  api: Api,
  opts: { authorize?: (socket: net.Socket) => Promise<boolean> } = {},
): Promise<net.Server> {
  const server = net.createServer(socket => {
    const reader = new FrameReader()
    let chain: Promise<void> = Promise.resolve()
    socket.on('error', () => {})
    socket.on('data', chunk => {
      let frames: unknown[]
      try { frames = reader.push(chunk as Buffer) } catch (e) {
        if (e instanceof FrameTooLarge) socket.destroy()
        return
      }
      for (const f of frames) {
        chain = chain.then(async () => {
          const id = isObj(f) && Number.isInteger(f.id) ? (f.id as number) : 0
          let res: Response
          try {
            const allowed = opts.authorize ? await opts.authorize(socket) : true
            if (!allowed) res = { id, ok: false, message: 'caller not allowed' }
            else res = await dispatch(api, f)
          } catch {
            res = { id, ok: false, message: 'internal error' }
          }
          if (!socket.destroyed) socket.write(encode(res))
        })
      }
    })
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(path, () => { server.off('error', reject); resolve(server) })
  })
}
