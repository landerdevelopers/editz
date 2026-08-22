import assert from 'node:assert/strict'
import { LAYOUTS, coverRect, panelBox } from './public/layouts.js'
import { separateRows, freeStart, rowLimits } from './public/arrange.js'

const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps

// --- layouts tile their space exactly -----------------------------------
for (const [name, rects] of Object.entries(LAYOUTS)) {
  for (const [x, y, w, h] of rects) {
    assert.ok(w > 0 && h > 0, `${name}: non-positive cell`)
    assert.ok(x >= 0 && y >= 0 && x + w <= 1 + 1e-9 && y + h <= 1 + 1e-9,
      `${name}: cell out of bounds`)
  }

  if (name === 'pip') continue // intentionally overlaps

  const [cols, rows] = name.split('x').map(Number)
  assert.equal(rects.length, cols * rows, `${name}: wrong cell count`)

  const area = rects.reduce((s, [, , w, h]) => s + w * h, 0)
  assert.ok(near(area, 1), `${name}: cells cover ${area}, not 1.0`)

  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const [ax, ay, aw, ah] = rects[i], [bx, by, bw, bh] = rects[j]
      const overlap = Math.max(0, Math.min(ax + aw, bx + bw) - Math.max(ax, bx)) *
                      Math.max(0, Math.min(ay + ah, by + bh) - Math.max(ay, by))
      assert.ok(near(overlap, 0), `${name}: cells ${i}/${j} overlap`)
    }
  }
}

// --- cover-fit crop ------------------------------------------------------
// 16:9 source into a 9:16 cell -> full height, horizontally centered.
let r = coverRect(1920, 1080, 1080, 1920)
assert.equal(r.sh, 1080, 'wide source should keep full height')
assert.ok(near(r.sw, 607.5), 'wide source width')
assert.equal(r.sy, 0)
assert.ok(near(r.sx, (1920 - 607.5) / 2), 'wide source should be centered')

// 9:16 source into a 16:9 cell -> full width, vertically centered.
r = coverRect(1080, 1920, 1920, 1080)
assert.equal(r.sw, 1080, 'tall source should keep full width')
assert.ok(near(r.sh, 607.5), 'tall source height')
assert.equal(r.sx, 0)
assert.ok(near(r.sy, (1920 - 607.5) / 2), 'tall source should be centered')

// matching aspect -> whole frame, no crop
r = coverRect(1920, 1080, 1920, 1080)
assert.deepEqual([r.sx, r.sy, r.sw, r.sh], [0, 0, 1920, 1080], 'same aspect = no crop')

// zoom crops tighter and stays inside the source
r = coverRect(1920, 1080, 1920, 1080, { zoom: 2 })
assert.ok(near(r.sw, 960) && near(r.sh, 540), 'zoom 2 halves the source rect')

// pan clamps to the edges, never outside
for (const panX of [-3, -1, 0, 1, 3]) {
  const p = coverRect(1920, 1080, 1080, 1920, { panX })
  assert.ok(p.sx >= 0 && p.sx + p.sw <= 1920, `pan ${panX} escaped the source`)
}

// --- one sequence per row -------------------------------------------------
const clip = (id, row, start, dur) => ({ id, row, start, dur })

// clips overlapping on the SAME row get pushed apart, in order
let cs = [clip('a', 0, 0, 4), clip('b', 0, 2, 3)]
separateRows(cs)
assert.deepEqual(cs.map((c) => c.start), [0, 4], 'same-row overlap must be separated')

// clips overlapping on DIFFERENT rows are left alone -- that's layering
cs = [clip('a', 0, 0, 4), clip('b', 1, 2, 3)]
separateRows(cs)
assert.deepEqual(cs.map((c) => c.start), [0, 2], 'cross-row overlap is legal')

// a chain of overlaps resolves in one pass, and re-running changes nothing
cs = [clip('a', 0, 0, 3), clip('b', 0, 1, 3), clip('c', 0, 2, 3)]
separateRows(cs)
const once = cs.map((c) => c.start)
assert.deepEqual(once, [0, 3, 6], 'chained overlaps pack left to right')
separateRows(cs)
assert.deepEqual(cs.map((c) => c.start), once, 'separateRows must be idempotent')

// gaps are preserved -- packing only closes overlaps, never tidies spacing
cs = [clip('a', 0, 0, 2), clip('b', 0, 10, 2)]
separateRows(cs)
assert.deepEqual(cs.map((c) => c.start), [0, 10], 'gaps are left alone')

// --- dropping a clip finds free space ------------------------------------
const row = [clip('a', 0, 0, 4), clip('b', 0, 10, 4)]
const moving = clip('m', 0, 0, 2)

// dropped deep inside a clip: pushed to whichever edge is nearer
assert.equal(freeStart(row, moving, 3, 0), 4, 'near the right edge -> lands after')
assert.equal(freeStart(row, moving, 0.2, 0), 4, 'no room on the left -> lands after')
// lands in the gap untouched
assert.equal(freeStart(row, moving, 6, 0), 6, 'free space is left alone')
// never negative
assert.ok(freeStart(row, moving, -5, 0) >= 0, 'start can never go negative')
// a clip that fits before the first one keeps its left slot
const early = [clip('a', 0, 5, 4)]
assert.equal(freeStart(early, clip('m', 0, 0, 2), 4, 0), 3, 'slides left when that is nearer')

// resolved positions never overlap
for (const want of [-2, 0, 1, 3, 4.5, 9, 11, 20]) {
  const at = freeStart(row, moving, want, 0)
  const bad = row.find((o) => at < o.start + o.dur && at + moving.dur > o.start)
  assert.ok(!bad, `freeStart(${want}) landed on top of ${bad?.id}`)
}

// --- trims stop at neighbours --------------------------------------------
const lim = rowLimits(row, clip('m', 0, 5, 3))
assert.equal(lim.prevEnd, 4, 'previous clip ends at 4')
assert.equal(lim.nextStart, 10, 'next clip starts at 10')
assert.equal(rowLimits([], clip('m', 0, 0, 1)).nextStart, Infinity, 'no neighbour = no cap')

// --- gap and padding are independent ------------------------------------
const frame = { out: { w: 1920, h: 1080 } }
const TL = [0, 0, 0.5, 0.5], TR = [0.5, 0, 0.5, 0.5], BR = [0.5, 0.5, 0.5, 0.5]

// neither set: panels tile the frame exactly
assert.deepEqual(panelBox(frame, TL), [0, 0, 960, 540], 'no gap/pad = exact quarters')

// gap only: space appears BETWEEN panels but not around the outside
let g = { ...frame, gap: 40 }
let a = panelBox(g, TL), b = panelBox(g, TR), c = panelBox(g, BR)
assert.equal(a[0], 0, 'gap alone must not indent the left edge')
assert.equal(a[1], 0, 'gap alone must not indent the top edge')
assert.equal(b[0] - (a[0] + a[2]), 40, 'gap between horizontal neighbours')
assert.equal(c[1] - (a[1] + a[3]), 40, 'gap between vertical neighbours')
assert.equal(c[0] + c[2], 1920, 'right edge stays flush')
assert.equal(c[1] + c[3], 1080, 'bottom edge stays flush')

// pad only: margin around the outside, panels still touch each other
let q = { ...frame, pad: 60 }
a = panelBox(q, TL); b = panelBox(q, TR); c = panelBox(q, BR)
assert.equal(a[0], 60, 'pad indents the left edge')
assert.equal(b[0] - (a[0] + a[2]), 0, 'pad alone leaves no gap between panels')
assert.equal(c[0] + c[2], 1920 - 60, 'pad indents the right edge')

// both together, independently
let both = { ...frame, gap: 40, pad: 60 }
a = panelBox(both, TL); b = panelBox(both, TR); c = panelBox(both, BR)
assert.equal(a[0], 60, 'outer margin is pad, not pad + half gap')
assert.equal(b[0] - (a[0] + a[2]), 40, 'inner spacing is gap')
assert.equal(c[0] + c[2], 1860, 'right edge respects pad')
assert.equal(c[1] + c[3], 1020, 'bottom edge respects pad')

// a full-frame panel gets padding but no gap, having no neighbours
assert.deepEqual(panelBox(both, [0, 0, 1, 1]), [60, 60, 1800, 960], 'full frame = pad only')

console.log('layouts + crop + row arrangement + spacing ok')
