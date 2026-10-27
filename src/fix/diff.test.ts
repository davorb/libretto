import { describe, expect, it } from 'vitest'
import { unifiedDiff } from './diff.js'

describe('unifiedDiff', () => {
  it('is empty for equal text', () => {
    expect(unifiedDiff('a\nb\n', 'a\nb\n', 'x.md')).toBe('')
  })

  it('shows a replaced line with context and a correct hunk header', () => {
    const diff = unifiedDiff('1\n2\n3\n4\n5\n6\n7\n8\n9\n10\n', '1\n2\n3\n4\nfive\n6\n7\n8\n9\n10\n', 'x.md')
    expect(diff).toBe(['--- a/x.md', '+++ b/x.md', '@@ -2,7 +2,7 @@', ' 2', ' 3', ' 4', '-5', '+five', ' 6', ' 7', ' 8'].join('\n'))
  })

  it('splits distant changes into separate hunks', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`).join('\n')
    const b = a.replace('l1\n', 'L1\n').replace('l18', 'L18')
    const diff = unifiedDiff(a, b, 'x.md')
    expect(diff.match(/^@@/gm)).toHaveLength(2)
  })

  it('handles additions to an empty file', () => {
    expect(unifiedDiff('', 'a\n', 'x.md')).toBe(['--- a/x.md', '+++ b/x.md', '@@ -0,0 +1,1 @@', '+a'].join('\n'))
  })
})
