import { describe, expect, it } from 'vitest'
import { checkPlaywrightCdp, type Proc } from '../src/core/doctor.js'

const PW = '"node" "C:\\npm-cache\\_npx\\x\\node_modules\\@playwright\\mcp\\cli.js"'
const PW_CDP = `${PW} --cdp-endpoint http://127.0.0.1:9222`

// claude.exe(100) -> cmd(101) -> node u-chan(102)       <- self
//                 -> cmd(110) -> node npx(111) -> node cli.js(112)
const tree = (pwCmd: string): Proc[] => [
  { pid: 100, ppid: 1, name: 'claude.exe', cmd: 'claude' },
  { pid: 101, ppid: 100, name: 'cmd.exe', cmd: 'cmd /c u-chan-secrets' },
  { pid: 102, ppid: 101, name: 'node.exe', cmd: 'node dist/index.js' },
  { pid: 110, ppid: 100, name: 'cmd.exe', cmd: 'cmd /c npx @playwright/mcp@latest' },
  { pid: 111, ppid: 110, name: 'node.exe', cmd: 'node npx-cli.js @playwright/mcp@latest' },
  { pid: 112, ppid: 111, name: 'node.exe', cmd: pwCmd },
]

describe('checkPlaywrightCdp', () => {
  it('is ok when the same session Playwright has --cdp-endpoint', () => {
    expect(checkPlaywrightCdp(tree(PW_CDP), 102)).toBe('ok')
  })
  it('reports missing when the same session Playwright lacks --cdp-endpoint', () => {
    expect(checkPlaywrightCdp(tree(PW), 102)).toBe('missing')
  })
  it('ignores Playwright processes owned by another app', () => {
    const procs = [
      ...tree(PW_CDP).filter((p) => p.pid < 110),
      { pid: 200, ppid: 1, name: 'codex.exe', cmd: 'codex' },
      { pid: 201, ppid: 200, name: 'node.exe', cmd: PW },
    ]
    expect(checkPlaywrightCdp(procs, 102)).toBe('not_found')
  })
  it('is not_found when the client process is gone', () => {
    expect(checkPlaywrightCdp([{ pid: 102, ppid: 999, name: 'node.exe', cmd: 'node' }], 102)).toBe('not_found')
  })
})
