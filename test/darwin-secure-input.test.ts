import { expect, it } from 'vitest'
import { runInNewContext } from 'node:vm'
import { buildJxaPromptScript } from '../src/platform/darwin/prompt-script.js'

it('enables secure input during password entry and disables it on modal failure', () => {
  const events: string[] = []
  const alert = { addButtonWithTitle() {}, window: {}, runModal: 0 }
  Object.defineProperty(alert, 'runModal', { get() { events.push('modal'); throw new Error('closed') } })
  const $: any = {
    NSAlert: { alloc: { init: alert } }, NSSecureTextField: { alloc: { initWithFrame: () => ({}) } },
    NSMakeRect() {}, EnableSecureEventInput() { events.push('enable'); return 0 },
    DisableSecureEventInput() { events.push('disable'); return 0 }, exit() { throw new Error('exit') },
  }
  try { runInNewContext(buildJxaPromptScript({ title: 'test', phrase: 'test', lines: [] }), {
    $, ObjC: { import() {}, bindFunction() {} },
  }) } catch {}
  expect(events).toEqual(['enable', 'modal', 'disable'])
})
