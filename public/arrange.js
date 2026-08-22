// Row arrangement rules, kept free of the DOM so they can be tested directly.
//
// Overlap ACROSS rows is the point — that's layering. Overlap WITHIN a row is
// not: two clips at the same z-order, both audio tracks playing, is ambiguous.
// A row holds a sequence; these two functions are what keep it one.

// Left-to-right sweep that pushes right only, so it's stable and idempotent.
export function separateRows(clips) {
  const byRow = new Map()
  for (const c of clips) {
    if (!byRow.has(c.row)) byRow.set(c.row, [])
    byRow.get(c.row).push(c)
  }
  for (const list of byRow.values()) {
    list.sort((a, b) => a.start - b.start || String(a.id).localeCompare(String(b.id)))
    let edge = 0
    for (const c of list) {
      if (c.start < edge) c.start = edge
      edge = c.start + c.dur
    }
  }
  return clips
}

// Where a dragged clip can actually land: slide to the nearer free side of
// whatever blocks it, so it butts up against a neighbour instead of overlapping.
export function freeStart(clips, clip, want, row) {
  const others = clips.filter((c) => c.id !== clip.id && c.row === row)
  const blocker = (at) => others.find((o) => at < o.start + o.dur && at + clip.dur > o.start)
  const s0 = Math.max(0, want)
  const first = blocker(s0)
  if (!first) return s0

  const leftSlot = first.start - clip.dur
  if (leftSlot >= 0 && Math.abs(s0 - leftSlot) <= Math.abs(s0 - (first.start + first.dur))) {
    let l = leftSlot
    for (let g = 0; g <= others.length && blocker(l); g++) l = blocker(l).start - clip.dur
    if (l >= 0 && !blocker(l)) return l
  }
  // Rightwards always terminates: each step clears one more blocker in order.
  let s = s0
  for (let g = 0; g <= others.length && blocker(s); g++) {
    const b = blocker(s)
    s = b.start + b.dur
  }
  return s
}

// How far a trim can run before it meets a neighbour on the same row.
export function rowLimits(clips, clip) {
  const others = clips.filter((c) => c.id !== clip.id && c.row === clip.row)
  const ends = others.filter((o) => o.start + o.dur <= clip.start + 1e-3).map((o) => o.start + o.dur)
  const starts = others.filter((o) => o.start >= clip.start + clip.dur - 1e-3).map((o) => o.start)
  return { prevEnd: Math.max(0, ...ends), nextStart: Math.min(Infinity, ...starts) }
}
