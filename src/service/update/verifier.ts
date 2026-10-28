import crypto from 'node:crypto'
import type { PackageMetadata, PackageVerifier, VerificationOutcome } from '../../core/types.js'

export const DEFAULT_NPM_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE1Olb3/MAFFxXKHiIkQO5cJ3Yhl5i
6UPp+IhuteBJbuHcA5UogKo0EWtlWwW6KSaKoTNEYL7JlCQiVnkhBktUgg==
-----END PUBLIC KEY-----`

export interface VerifierOptions {
  packageName?: string
  registryUrl?: string
  npmPublicKey?: string
  expectedRepo?: string
  fetcher?: typeof fetch
}

export function parseSemver(v: string): { major: number; minor: number; patch: number; prerelease?: string } | null {
  const m = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(v.trim())
  if (!m) return null
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4],
  }
}

function comparePrerelease(p1: string, p2: string): number {
  const a = p1.split('.')
  const b = p2.split('.')
  const len = Math.max(a.length, b.length)
  for (let i = 0; i < len; i++) {
    if (a[i] === undefined) return -1
    if (b[i] === undefined) return 1
    if (a[i] === b[i]) continue
    const n1 = /^\d+$/.test(a[i]) ? Number(a[i]) : NaN
    const n2 = /^\d+$/.test(b[i]) ? Number(b[i]) : NaN
    if (!Number.isNaN(n1) && !Number.isNaN(n2)) return n1 - n2
    if (!Number.isNaN(n1)) return -1
    if (!Number.isNaN(n2)) return 1
    return a[i] < b[i] ? -1 : 1
  }
  return 0
}

export function semverGt(v1: string, v2: string): boolean {
  const s1 = parseSemver(v1)
  const s2 = parseSemver(v2)
  if (!s1 || !s2) return v1 > v2
  if (s1.major !== s2.major) return s1.major > s2.major
  if (s1.minor !== s2.minor) return s1.minor > s2.minor
  if (s1.patch !== s2.patch) return s1.patch > s2.patch
  if (!s1.prerelease && s2.prerelease) return true
  if (s1.prerelease && !s2.prerelease) return false
  if (s1.prerelease && s2.prerelease) return comparePrerelease(s1.prerelease, s2.prerelease) > 0
  return false
}

function normalizeRepo(url: string): string {
  return url.trim().replace(/\.git$/, '').toLowerCase()
}

function extractRepoFromBundle(bundle: unknown): string | null {
  if (!bundle || typeof bundle !== 'object') return null
  const obj = bundle as Record<string, unknown>
  if (typeof obj.repository === 'string') return obj.repository
  if (typeof obj.repo === 'string') return obj.repo
  if (Array.isArray(obj.attestations)) {
    for (const a of obj.attestations) {
      const r = extractRepoFromBundle(a)
      if (r) return r
    }
  }
  if (obj.predicate && typeof obj.predicate === 'object') {
    const p = obj.predicate as Record<string, unknown>
    if (typeof p.repository === 'string') return p.repository
    if (typeof p.repo === 'string') return p.repo
    const uri =
      (p.invocation as { configSource?: { uri?: unknown } } | undefined)?.configSource?.uri ??
      (p.buildDefinition as { externalParameters?: { source?: { uri?: unknown } } } | undefined)?.externalParameters?.source?.uri
    if (typeof uri === 'string') return uri
  }
  return null
}

export class NpmPackageVerifier implements PackageVerifier {
  private readonly packageName: string
  private readonly registryUrl: string
  private readonly npmPublicKey: string
  private readonly requireSignature: boolean
  private readonly expectedRepo: string
  private readonly fetcher: typeof fetch

  constructor(opts: VerifierOptions = {}) {
    this.packageName = opts.packageName ?? 'u-chan-secrets'
    this.registryUrl = (opts.registryUrl ?? 'https://registry.npmjs.org').replace(/\/$/, '')
    this.npmPublicKey = opts.npmPublicKey ?? DEFAULT_NPM_PUBLIC_KEY
    this.requireSignature = opts.npmPublicKey !== undefined
    this.expectedRepo = opts.expectedRepo ?? 'https://github.com/anchuwithdeadline/u-chan-secrets'
    this.fetcher = opts.fetcher ?? globalThis.fetch
  }

  async checkLatest(currentVersion: string): Promise<{ isNewer: boolean; latestVersion: string }> {
    const res = await this.fetcher(`${this.registryUrl}/${this.packageName}`)
    if (!res.ok) {
      throw new Error(`failed to fetch package metadata: ${res.statusText || res.status}`)
    }
    const meta = (await res.json()) as PackageMetadata
    const latest = meta['dist-tags']?.latest
    if (!latest) {
      throw new Error('no latest dist-tag found in package metadata')
    }
    return {
      isNewer: semverGt(latest, currentVersion),
      latestVersion: latest,
    }
  }

  async verify(targetVersion: string): Promise<VerificationOutcome> {
    try {
      const res = await this.fetcher(`${this.registryUrl}/${this.packageName}`)
      if (!res.ok) {
        return { ok: false, error: 'failed to fetch package metadata' }
      }
      const meta = (await res.json()) as PackageMetadata
      const versionInfo = meta.versions?.[targetVersion]
      if (!versionInfo) {
        return { ok: false, error: 'target version not found in registry metadata' }
      }

      const dist = versionInfo.dist
      if (!dist?.tarball) {
        return { ok: false, error: 'no tarball URL in version info' }
      }

      const tarballRes = await this.fetcher(dist.tarball)
      if (!tarballRes.ok) {
        return { ok: false, error: 'failed to download tarball' }
      }
      const arrayBuf = await tarballRes.arrayBuffer()
      const tarball = Buffer.from(arrayBuf)

      // 1. SHA-512 SRI check (mandatory)
      const hash = 'sha512-' + crypto.createHash('sha512').update(tarball).digest('base64')
      if (!dist.integrity || hash !== dist.integrity) {
        return { ok: false, error: 'integrity check failed' }
      }

      // 2. ECDSA signature check
      const hasSignatures = Array.isArray(dist.signatures) && dist.signatures.length > 0
      const hasAttestations = Boolean(dist.attestations?.url)
      if (!hasSignatures && (this.requireSignature || !hasAttestations)) {
        return { ok: false, error: 'registry signature verification failed' }
      }
      if (hasSignatures && this.npmPublicKey) {
        const signedStr = `${this.packageName}@${targetVersion}:${dist.shasum}`
        const signedData = Buffer.from(signedStr, 'utf8')
        let valid = false
        for (const s of dist.signatures!) {
          try {
            if (crypto.verify(null, signedData, this.npmPublicKey, Buffer.from(s.sig, 'base64'))) {
              valid = true
              break
            }
          } catch {}
        }
        if (!valid) {
          return { ok: false, error: 'registry signature verification failed' }
        }
      }

      // 3. Provenance check
      if (dist.attestations?.url) {
        const attRes = await this.fetcher(dist.attestations.url)
        if (!attRes.ok) {
          return { ok: false, error: 'failed to fetch provenance attestation' }
        }
        const bundle = await attRes.json()
        const repo = extractRepoFromBundle(bundle)
        if (!repo || normalizeRepo(repo) !== normalizeRepo(this.expectedRepo)) {
          return { ok: false, error: 'provenance repository mismatch' }
        }
      }

      return {
        ok: true,
        targetVersion,
        tarball,
      }
    } catch (err) {
      return { ok: false, error: (err as Error).message ?? 'verification failed' }
    }
  }
}
