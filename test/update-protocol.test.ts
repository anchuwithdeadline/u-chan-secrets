import { expect, it } from 'vitest'
import { identitySchema, jobSchema, planDecision } from '../src/service/update/protocol.js'
import { integrity } from './fixtures/update-release.js'
it('does not claim matching versions identify unknown local builds or allow downgrades', () => {
  const target = { version: '2.1.0', integrity: integrity(Buffer.from('release')) }
  expect(identitySchema.safeParse(target).success).toBe(true)
  expect(identitySchema.safeParse({ ...target, integrity: 'unsafe' }).success).toBe(false)
  expect(planDecision({ version: '2.1.0', integrity: null }, target)).toBe('identity_unknown')
  expect(planDecision({ version: '3.0.0', integrity: null }, target)).toBe('local_ahead')
  expect(planDecision(target, target)).toBe('up_to_date')
  expect(planDecision({ version: '2.0.0', integrity: null }, target)).toBe('update_required')
  expect(jobSchema.safeParse({ path: 'C:/arbitrary', phase: 'switching' }).success).toBe(false)
})
