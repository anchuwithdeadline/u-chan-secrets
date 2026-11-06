import { expect, it } from 'vitest'
import { PROMPT_HELPER_CSHARP } from '../src/platform/windows/assets/prompt-src.js'
it('renders protected review in a wrapped read-only scrolling surface without ellipsis', () => {
  expect(PROMPT_HELPER_CSHARP).toContain('details.ReadOnly = true;')
  expect(PROMPT_HELPER_CSHARP).toContain('details.ScrollBars = ScrollBars.Vertical;')
  expect(PROMPT_HELPER_CSHARP).not.toContain('lbl.AutoEllipsis = true;')
  expect(PROMPT_HELPER_CSHARP).toContain('txtPassword.UseSystemPasswordChar = true;')
  expect(PROMPT_HELPER_CSHARP).toContain('CreateDesktop')
})
