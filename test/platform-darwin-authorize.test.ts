import { describe, it, expect, vi } from 'vitest'
import net from 'node:net'
import { createDarwinAuthorizer, readInstallUid } from '../src/platform/darwin/authorize.js'
import { resolveDarwinPeerCred } from '../src/platform/darwin/peercred.js'
import { platformAdapters } from '../src/platform/index.js'

describe('macOS socket authorization', () => {
  it('accepts connection when peer UID matches install UID', async () => {
    const socket = new net.Socket()
    const authorize = createDarwinAuthorizer({
      installUid: 501,
      resolvePeerCred: async () => ({ uid: 501 }),
    })
    expect(await authorize(socket)).toBe(true)
  })

  it('rejects connection when peer UID does not match installing user', async () => {
    const socket = new net.Socket()
    const authorize = createDarwinAuthorizer({
      installUid: 501,
      resolvePeerCred: async () => ({ uid: 502 }),
    })
    expect(await authorize(socket)).toBe(false)
  })

  it('rejects connection when peer credentials cannot be resolved', async () => {
    const socket = new net.Socket()
    const authorize = createDarwinAuthorizer({
      installUid: 501,
      resolvePeerCred: async () => null,
    })
    expect(await authorize(socket)).toBe(false)
  })

  it('reads install UID from owner file', async () => {
    const tmpFile = 'test/fixtures/fake-owner.json'
    // owner file contains {"installUid": 501, "installUser": "alice"}
    const uid = await readInstallUid(tmpFile)
    expect(uid).toBe(501)
  })

  it('handles missing or malformed owner file gracefully', async () => {
    expect(await readInstallUid('non-existent-owner.json')).toBeNull()
    const socket = new net.Socket()
    const authorize = createDarwinAuthorizer({
      ownerPath: 'non-existent-owner.json',
      resolvePeerCred: async () => ({ uid: 501 }),
    })
    expect(await authorize(socket)).toBe(false)
  })

  it('resolveDarwinPeerCred returns null when no fd or non-darwin', async () => {
    const socket = new net.Socket()
    const cred = await resolveDarwinPeerCred(socket)
    if (process.platform !== 'darwin') {
      expect(cred).toBeNull()
    }
  })

  it('wires into platformAdapters for darwin', async () => {
    const socket = new net.Socket()
    const adapters = platformAdapters('darwin', {
      installUid: 501,
      resolvePeerCred: async () => ({ uid: 501 }),
    })
    expect(typeof adapters.authorize).toBe('function')
    expect(await adapters.authorize(socket)).toBe(true)
  })
})
