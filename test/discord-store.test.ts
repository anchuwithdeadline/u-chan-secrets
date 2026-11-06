import { describe, expect, it } from 'vitest'
import { mkdtemp, realpath, readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscordStore } from '../src/discord/store.js'
const c = { alias: 'vdn', item: 'VDN Discord Bot', field: { kind: 'password' as const }, guildId: '123456789012345678' }
describe('DiscordStore', () => {
  it('validates whole state and writes metadata after backup prerequisites', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'ucs-discord-'))), path = join(home, 'discord-allowlist.json')
    let backups = 0
    const store = new DiscordStore(path, async () => { backups++ })
    expect(await store.list()).toEqual([])
    await store.upsert(c)
    expect(backups).toBe(1)
    expect(await store.get('vdn')).toEqual(c)
    expect(await readFile(path, 'utf8')).not.toContain('token')
    await writeFile(path, JSON.stringify([c, c]))
    await expect(store.list()).rejects.toThrow('Discord connection state is invalid')
    await writeFile(path, JSON.stringify([{ ...c, token: 'SECRET' }]))
    await expect(store.list()).rejects.toThrow()
  })
  it('fails writes on backup failure and refuses a linked state directory', async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'ucs-discord-'))), path = join(home, 'discord-allowlist.json')
    await expect(new DiscordStore(path, async () => { throw new Error('backup failed') }).upsert(c)).rejects.toThrow('backup failed')
    await expect(readFile(path)).rejects.toThrow()
    const target = join(home, 'real'), linked = join(home, 'link')
    await mkdir(target)
    await symlink(target, linked, 'junction')
    await expect(new DiscordStore(join(linked, 'discord.json')).upsert(c)).rejects.toThrow()
  })
})
