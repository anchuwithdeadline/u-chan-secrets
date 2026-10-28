import crypto from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { NpmPackageVerifier } from '../src/service/update/verifier.js'
import type { PackageMetadata } from '../src/core/types.js'

describe('NpmPackageVerifier', () => {
  const currentVersion = '2.0.0'
  const newVersion = '2.1.0'

  it('detects when new version is available', async () => {
    const metadata: PackageMetadata = {
      'dist-tags': { latest: newVersion },
      versions: {
        [newVersion]: {
          version: newVersion,
          dist: {
            tarball: 'https://registry.npmjs.org/u-chan-secrets/-/u-chan-secrets-2.1.0.tgz',
            shasum: 'abc',
          },
        },
      },
    }

    const fetcher = vi.fn(async (_url: string | URL | Request) => ({
      ok: true,
      status: 200,
      json: async () => metadata,
    }) as unknown as Response)

    const verifier = new NpmPackageVerifier({ fetcher })
    const result = await verifier.checkLatest(currentVersion)
    expect(result).toEqual({ isNewer: true, latestVersion: newVersion })
  })

  it('detects when current version is already up to date', async () => {
    const metadata: PackageMetadata = {
      'dist-tags': { latest: currentVersion },
      versions: {
        [currentVersion]: {
          version: currentVersion,
          dist: {
            tarball: 'https://registry.npmjs.org/u-chan-secrets/-/u-chan-secrets-2.0.0.tgz',
            shasum: 'abc',
          },
        },
      },
    }

    const fetcher = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => metadata,
    }) as unknown as Response)

    const verifier = new NpmPackageVerifier({ fetcher })
    const result = await verifier.checkLatest(currentVersion)
    expect(result).toEqual({ isNewer: false, latestVersion: currentVersion })
  })

  it('verifies valid package with matching SHA-512 and valid signature', async () => {
    const tarball = Buffer.from('package-tarball-content')
    const shasum = crypto.createHash('sha1').update(tarball).digest('hex')
    const sri = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64')

    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const npmPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const signedStr = `u-chan-secrets@${newVersion}:${shasum}`
    const sig = crypto.sign('sha256', Buffer.from(signedStr), privateKey).toString('base64')

    const metadata: PackageMetadata = {
      'dist-tags': { latest: newVersion },
      versions: {
        [newVersion]: {
          version: newVersion,
          dist: {
            tarball: `https://registry.npmjs.org/u-chan-secrets/-/u-chan-secrets-${newVersion}.tgz`,
            shasum,
            integrity: sri,
            signatures: [{ keyid: 'key-1', sig }],
          },
        },
      },
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString()
      if (u.endsWith('.tgz')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => metadata,
      } as unknown as Response
    })

    const verifier = new NpmPackageVerifier({ npmPublicKey, fetcher })
    const result = await verifier.verify(newVersion)
    expect(result.ok).toBe(true)
    expect(result.targetVersion).toBe(newVersion)
    expect(result.tarball).toEqual(tarball)
  })

  it('rejects tarball with mismatched integrity hash', async () => {
    const tarball = Buffer.from('package-tarball-content')
    const wrongSri = 'sha512-' + crypto.createHash('sha512').update(Buffer.from('different')).digest('base64')

    const metadata: PackageMetadata = {
      'dist-tags': { latest: newVersion },
      versions: {
        [newVersion]: {
          version: newVersion,
          dist: {
            tarball: `https://registry.npmjs.org/u-chan-secrets/-/u-chan-secrets-${newVersion}.tgz`,
            shasum: 'abc',
            integrity: wrongSri,
          },
        },
      },
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString()
      if (u.endsWith('.tgz')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => metadata,
      } as unknown as Response
    })

    const verifier = new NpmPackageVerifier({ fetcher })
    const result = await verifier.verify(newVersion)
    expect(result).toEqual({ ok: false, error: 'integrity check failed' })
  })

  it('rejects package with invalid registry signature', async () => {
    const tarball = Buffer.from('package-tarball-content')
    const shasum = crypto.createHash('sha1').update(tarball).digest('hex')
    const sri = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64')

    const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const npmPublicKey = publicKey.export({ type: 'spki', format: 'pem' }).toString()

    const metadata: PackageMetadata = {
      'dist-tags': { latest: newVersion },
      versions: {
        [newVersion]: {
          version: newVersion,
          dist: {
            tarball: `https://registry.npmjs.org/u-chan-secrets/-/u-chan-secrets-${newVersion}.tgz`,
            shasum,
            integrity: sri,
            signatures: [{ keyid: 'key-1', sig: Buffer.from('invalid-signature').toString('base64') }],
          },
        },
      },
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString()
      if (u.endsWith('.tgz')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => metadata,
      } as unknown as Response
    })

    const verifier = new NpmPackageVerifier({ npmPublicKey, fetcher })
    const result = await verifier.verify(newVersion)
    expect(result).toEqual({ ok: false, error: 'registry signature verification failed' })
  })

  it('rejects package when provenance repository does not match', async () => {
    const tarball = Buffer.from('package-tarball-content')
    const shasum = crypto.createHash('sha1').update(tarball).digest('hex')
    const sri = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64')

    const metadata: PackageMetadata = {
      'dist-tags': { latest: newVersion },
      versions: {
        [newVersion]: {
          version: newVersion,
          dist: {
            tarball: `https://registry.npmjs.org/u-chan-secrets/-/u-chan-secrets-${newVersion}.tgz`,
            shasum,
            integrity: sri,
            attestations: { url: 'https://registry.npmjs.org/-/npm/v1/attestations/u-chan-secrets@2.1.0' },
          },
        },
      },
    }

    const fetcher = vi.fn(async (url: string | URL | Request) => {
      const u = url.toString()
      if (u.endsWith('.tgz')) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () => tarball.buffer.slice(tarball.byteOffset, tarball.byteOffset + tarball.byteLength),
        } as unknown as Response
      }
      if (u.includes('attestations')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ repository: 'https://github.com/attacker/malicious' }),
        } as unknown as Response
      }
      return {
        ok: true,
        status: 200,
        json: async () => metadata,
      } as unknown as Response
    })

    const verifier = new NpmPackageVerifier({ fetcher, expectedRepo: 'https://github.com/anchuwithdeadline/u-chan-secrets' })
    const result = await verifier.verify(newVersion)
    expect(result).toEqual({ ok: false, error: 'provenance repository mismatch' })
  })
})
