const CONTEXT = 3

type Op = { readonly kind: ' ' | '-' | '+'; readonly text: string }

function lines(text: string): string[] {
  const parts = text.split('\n')
  if (parts.at(-1) === '') parts.pop()
  return parts
}

/** Line-level LCS edit script. Specs are small markdown files, so O(n*m) is fine. */
function script(a: readonly string[], b: readonly string[]): Op[] {
  const lcs = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
    }
  }
  const ops: Op[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) ops.push({ kind: ' ', text: a[i++]! }), j++
    else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) ops.push({ kind: '-', text: a[i++]! })
    else ops.push({ kind: '+', text: b[j++]! })
  }
  while (i < a.length) ops.push({ kind: '-', text: a[i++]! })
  while (j < b.length) ops.push({ kind: '+', text: b[j++]! })
  return ops
}

/** Unified diff of `before` → `after` with three lines of context. Empty string when equal. */
export function unifiedDiff(before: string, after: string, file: string): string {
  const ops = script(lines(before), lines(after))
  const changed = ops.flatMap((op, i) => (op.kind === ' ' ? [] : [i]))
  if (changed.length === 0) return ''

  const ranges: [number, number][] = []
  for (const i of changed) {
    const start = Math.max(0, i - CONTEXT)
    const end = Math.min(ops.length, i + CONTEXT + 1)
    const last = ranges.at(-1)
    if (last && start <= last[1]) last[1] = end
    else ranges.push([start, end])
  }

  const out = [`--- a/${file}`, `+++ b/${file}`]
  for (const [start, end] of ranges) {
    const before = ops.slice(0, start)
    let oldLine = before.filter((o) => o.kind !== '+').length + 1
    let newLine = before.filter((o) => o.kind !== '-').length + 1
    const hunk = ops.slice(start, end)
    const oldCount = hunk.filter((o) => o.kind !== '+').length
    const newCount = hunk.filter((o) => o.kind !== '-').length
    if (oldCount === 0) oldLine--
    if (newCount === 0) newLine--
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`)
    for (const op of hunk) out.push(`${op.kind}${op.text}`)
  }
  return out.join('\n')
}
