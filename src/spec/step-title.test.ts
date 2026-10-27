import { describe, expect, it } from 'vitest'
import { parseStepTitle, stepTitle } from './step-title.js'

describe('step titles', () => {
  it('reads well in Playwright output', () => {
    expect(stepTitle('steps', 2, 'Enter username `alice`')).toBe('Steps 2: Enter username `alice`')
    expect(stepTitle('expect', 1, 'The text is visible')).toBe('Expect 1: The text is visible')
  })

  it.each([
    'plain',
    'with: colon and Steps 3: nested prefix',
    'Expect 9: looks like another title',
    'ends with colon:',
    ' leading and trailing space ',
    'unicode … → ✓',
    'multi\nline',
    '',
    '{{env.ALICE_PASSWORD}} and "quotes"',
  ])('round-trips %j', (text) => {
    for (const section of ['steps', 'expect'] as const) {
      const title = stepTitle(section, 12, text)
      expect(parseStepTitle('valid credentials', title)).toEqual({ scenario: 'valid credentials', section, index: 12 })
      expect(title.slice(title.indexOf(': ') + 2)).toBe(text)
    }
  })

  it('returns null for titles Libretto did not render', () => {
    for (const t of ['Before Hooks', 'expect.poll', 'Steps 0: x', 'Steps 01: x', 'steps 1: x', 'Steps 1:x', 'Steps x: y', ' Steps 1: x']) {
      expect(parseStepTitle('s', t)).toBeNull()
    }
  })

  it('rejects indexes that are not 1-based integers', () => {
    expect(() => stepTitle('steps', 0, 'x')).toThrow(RangeError)
    expect(() => stepTitle('steps', 1.5, 'x')).toThrow(RangeError)
  })
})
