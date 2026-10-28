export const MAX_FRAME = 65536
export type Method =
  | 'login' | 'request_allow' | 'revoke' | 'list_allowed' | 'status'
  | 'unlock' | 'lock' | 'set_mode' | 'import_v1' | 'audit' | 'update'
export interface Request { id: number; method: Method; params: Record<string, unknown> }
export interface Response { id: number; ok: boolean; message: string }

export class FrameTooLarge extends Error {}

export function encode(msg: Request | Response): string {
  return JSON.stringify(msg) + '\n'
}

/** Splits a byte stream into newline-delimited JSON frames. Unparseable lines come back as `undefined`. */
export class FrameReader {
  private buf = Buffer.alloc(0)
  push(chunk: Buffer): unknown[] {
    this.buf = Buffer.concat([this.buf, chunk])
    const out: unknown[] = []
    let nl: number
    while ((nl = this.buf.indexOf(0x0a)) >= 0) {
      const line = this.buf.subarray(0, nl).toString('utf8')
      this.buf = this.buf.subarray(nl + 1)
      if (line.length > MAX_FRAME) throw new FrameTooLarge('frame too large')
      try { out.push(JSON.parse(line)) } catch { out.push(undefined) }
    }
    if (this.buf.length > MAX_FRAME) throw new FrameTooLarge('frame too large')
    return out
  }
}
