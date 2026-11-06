import { expect, it } from 'vitest'
import { UpdateGate } from '../src/service/update/gate.js'
it('does not switch during admitted credential work and rejects new work once paused', () => {
  const gate = new UpdateGate()
  const leave = gate.enter('unlock')!
  expect(gate.tryPause()).toBe(false)
  leave()
  expect(gate.tryPause()).toBe(true)
  expect(gate.enter('login')).toBeNull()
  expect(gate.enter('discord_inspect')).toBeNull()
  expect(gate.enter('confirm_update_ready')).toBeTypeOf('function')
  gate.resume()
  expect(gate.enter('login')).toBeTypeOf('function')
})
