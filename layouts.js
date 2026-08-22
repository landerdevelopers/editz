// Grid layouts as normalized rects [x, y, w, h] in 0..1 space.
// Named CxR — cols x rows. Adding a layout is one line.

const grid = (cols, rows) =>
  Array.from({ length: cols * rows }, (_, i) => [
    (i % cols) / cols, Math.floor(i / cols) / rows, 1 / cols, 1 / rows,
  ])

export const LAYOUTS = {
  '1x1': grid(1, 1),
  '2x1': grid(2, 1), // side by side
  '1x2': grid(1, 2), // stacked
  '3x1': grid(3, 1),
  '1x3': grid(1, 3),
  '2x2': grid(2, 2),
  '4x1': grid(4, 1),
  '1x4': grid(1, 4),
  '3x3': grid(3, 3),
  '4x4': grid(4, 4),
  // Overlay first: cell 1 is the topmost layer, so it's the small inset.
  pip: [[0.68, 0.68, 0.3, 0.3], [0, 0, 1, 1]],
}

const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)

// Source rect that fills the destination without letterboxing ("cover").
// zoom >= 1 crops tighter; panX/panY in -1..1, 0 = centered.
export function coverRect(srcW, srcH, dstW, dstH, { zoom = 1, panX = 0, panY = 0 } = {}) {
  const scale = Math.max(dstW / srcW, dstH / srcH) * zoom
  const sw = Math.min(srcW, dstW / scale)
  const sh = Math.min(srcH, dstH / scale)
  return {
    sx: clamp(((srcW - sw) / 2) * (1 + panX), 0, srcW - sw),
    sy: clamp(((srcH - sh) / 2) * (1 + panY), 0, srcH - sh),
    sw, sh,
  }
}

// Where a normalized panel rect lands in the output frame.
//   pad — margin around the whole frame
//   gap — space between neighbouring panels
// Panels are inset by half a gap on interior edges only, so the outer edge sits
// flush against the padding instead of picking up half a gap as well.
export function panelBox({ out, gap = 0, pad = 0 }, [rx, ry, rw, rh]) {
  const half = gap / 2
  const fw = out.w - 2 * pad, fh = out.h - 2 * pad
  const l = rx <= 1e-3 ? 0 : half
  const r = rx + rw >= 1 - 1e-3 ? 0 : half
  const t = ry <= 1e-3 ? 0 : half
  const b = ry + rh >= 1 - 1e-3 ? 0 : half
  return [pad + rx * fw + l, pad + ry * fh + t, rw * fw - l - r, rh * fh - t - b]
}
