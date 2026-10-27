import net from 'node:net'
import type { ApprovalMode, ControlApi, CoreApi, Selectors, ToolResult } from '../core/types.js'
import { FrameReader, encode, type Method } from './protocol.js'

const DOWN = 'U-Chan service is not running — run u-chan install'

/** One connection per call; the service does all privileged work. */
export class IpcClient implements CoreApi, ControlApi {
  private nextId = 1
  private timeoutMs: number
  constructor(private path: string, opts: { timeoutMs?: number } = {}) {
    this.timeoutMs = opts.timeoutMs ?? 180000
  }

  private call(method: Method, params: Record<string, unknown> = {}): Promise<ToolResult> {
    const id = this.nextId++
    return new Promise(resolve => {
      const reader = new FrameReader()
      const socket = net.connect(this.path)
      let done = false
      const finish = (r: ToolResult) => {
        if (done) return
        done = true
        clearTimeout(timer)
        socket.destroy()
        resolve(r)
      }
      const timer = setTimeout(() => finish({ ok: false, message: 'U-Chan service timed out' }), this.timeoutMs)
      socket.on('connect', () => socket.write(encode({ id, method, params })))
      socket.on('data', chunk => {
        try {
          for (const f of reader.push(chunk as Buffer)) {
            const r = f as { id?: unknown; ok?: unknown; message?: unknown } | undefined
            if (r && r.id === id && typeof r.ok === 'boolean' && typeof r.message === 'string') {
              return finish({ ok: r.ok, message: r.message })
            }
          }
        } catch { finish({ ok: false, message: 'U-Chan service sent a bad response' }) }
      })
      socket.on('error', (e: NodeJS.ErrnoException) =>
        finish({ ok: false, message: e.code === 'ECONNREFUSED' || e.code === 'ENOENT' ? DOWN : 'U-Chan service connection failed' }))
      socket.on('close', () => finish({ ok: false, message: 'U-Chan service closed the connection' }))
    })
  }

  login(domain: string) { return this.call('login', { domain }) }
  requestAllow(domain: string, loginUrl: string, item: string, selectors?: Selectors) {
    return this.call('request_allow', { domain, loginUrl, item, ...(selectors ? { selectors } : {}) })
  }
  revoke(domain: string) { return this.call('revoke', { domain }) }
  listAllowed() { return this.call('list_allowed') }
  status() { return this.call('status') }
  unlock() { return this.call('unlock') }
  lock() { return this.call('lock') }
  setMode(mode: ApprovalMode) { return this.call('set_mode', { mode }) }
  importV1(entries: unknown[]) { return this.call('import_v1', { entries }) }
}
