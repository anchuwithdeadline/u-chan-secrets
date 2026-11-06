import { describe, expect, it } from 'vitest'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireDesktopLock, verifyDesktopFiles } from '../src/client/update-package.js'
import { writeRelease } from '../src/service/update/files.js'
import { inspectRelease } from '../src/service/update/release.js'
import { release } from './fixtures/update-release.js'

describe('desktop package boundaries',()=>{
  it('serializes callers with an OS lock released on close',async()=>{
    const home=await mkdtemp(join(tmpdir(),'u-chan-lock-'))
    const unlock=await acquireDesktopLock(home);expect(unlock).not.toBeNull()
    expect(await acquireDesktopLock(home)).toBeNull()
    await unlock!()
    const again=await acquireDesktopLock(home);expect(again).not.toBeNull();await again!()
  })
  it('detects post-install byte changes before issuing a receipt',async()=>{
    const home=await mkdtemp(join(tmpdir(),'u-chan-package-')),program=join(home,'program'),bytes=release()
    await writeRelease(program,inspectRelease(bytes))
    await verifyDesktopFiles(program,bytes)
    await writeFile(join(program,'dist/index.js'),'other')
    await expect(verifyDesktopFiles(program,bytes)).rejects.toThrow('desktop_artifact_mismatch')
  })
})
