// Canvas compositor, audio graph, playback clock, and export.
//
// Clips float freely: each one owns its own start on the timeline, its own
// length, and its own rect in the output frame. Nothing is aligned to anything
// else, so clips can overlap partially or not at all.
import { coverRect, panelBox } from './layouts.js'

const FULL = [0, 0, 1, 1]
const pool = new Map() // clip.id -> { video, srcId, gain }
let audioCtx, streamDest

export const totalDur = (state) =>
  state.clips.reduce((m, c) => Math.max(m, c.start + c.dur), 0)

// Everything on screen at t, topmost last so callers can draw in array order.
export const clipsAt = (state, t) =>
  state.clips
    .filter((c) => t >= c.start && t < c.start + c.dur)
    .sort((a, b) => b.row - a.row)

const rectOf = (clip) => clip.rect ?? FULL

function audio() {
  if (!audioCtx) {
    audioCtx = new AudioContext()
    streamDest = audioCtx.createMediaStreamDestination()
  }
  return audioCtx
}

// One <video> per clip, so the same source can appear many times at once.
function mediaFor(state, clip) {
  let m = pool.get(clip.id)
  if (m && m.srcId === clip.srcId) return m

  if (m) { m.video.pause(); m.video.remove() }
  const src = state.sources.find((s) => s.id === clip.srcId)
  if (!src) { pool.delete(clip.id); return null }

  const video = document.createElement('video')
  video.src = src.url
  video.preload = 'auto'
  video.playsInline = true
  document.getElementById('pool').append(video)

  // createMediaElementSource steals the element's audio from the speakers, so the
  // gain has to reach BOTH the monitor output and the recording destination.
  const ctx = audio()
  const gain = ctx.createGain()
  ctx.createMediaElementSource(video).connect(gain)
  gain.connect(ctx.destination)
  gain.connect(streamDest)

  m = { video, srcId: clip.srcId, gain }
  pool.set(clip.id, m)
  return m
}

export function dropClip(id) {
  const m = pool.get(id)
  if (m) { m.video.pause(); m.video.remove(); pool.delete(id) }
}

export function dropStale(state) {
  const live = new Set(state.clips.map((c) => c.id))
  for (const id of [...pool.keys()]) if (!live.has(id)) dropClip(id)
}

// Keep every element's play state, position, and volume in step with the clock.
export function sync(state, t, playing) {
  for (const clip of state.clips) {
    const m = mediaFor(state, clip)
    if (!m) continue
    const { video, gain } = m
    const live = t >= clip.start && t < clip.start + clip.dur
    gain.gain.value = live && !clip.muted ? clip.gain : 0
    if (!live) { if (!video.paused) video.pause(); continue }

    const want = clip.in + (t - clip.start)
    if (Math.abs(video.currentTime - want) > 0.3) video.currentTime = want
    if (playing && video.paused && want < video.duration) video.play().catch(() => {})
    if (!playing && !video.paused) video.pause()
  }
}

// Corner and edge grips, as fractions of the rect being framed.
export const HANDLES = [
  ['nw', 0, 0], ['n', 0.5, 0], ['ne', 1, 0],
  ['w', 0, 0.5], ['e', 1, 0.5],
  ['sw', 0, 1], ['s', 0.5, 1], ['se', 1, 1],
]

export { panelBox }

export function draw(ctx, state, t, highlightRect = null, frameRect = null) {
  const { w, h } = state.out
  ctx.fillStyle = state.bg || '#000000'
  ctx.fillRect(0, 0, w, h)

  // Sorted topmost-last by clipsAt, so plain array order gives correct z-order.
  for (const clip of clipsAt(state, t)) {
    const m = pool.get(clip.id)
    if (!m?.video.videoWidth) continue
    const [dx, dy, dw, dh] = panelBox(state, rectOf(clip))
    if (dw <= 0 || dh <= 0) continue
    const { video } = m
    // 9-arg drawImage crops and places in one call.
    const c = coverRect(video.videoWidth, video.videoHeight, dw, dh, clip)
    ctx.drawImage(video, c.sx, c.sy, c.sw, c.sh, dx, dy, dw, dh)
  }

  // Outline whatever is being dragged onto -- an occupied slot or an empty one.
  if (highlightRect) {
    const [bx, by, bw, bh] = panelBox(state, highlightRect)
    const lw = Math.max(5, w / 160)
    ctx.strokeStyle = '#f2edb8'
    ctx.lineWidth = lw
    ctx.setLineDash([w / 50, w / 70])
    ctx.strokeRect(bx + lw / 2, by + lw / 2, bw - lw, bh - lw)
    ctx.setLineDash([])
  }

  // Frame mode: outline the selected clip's panel and give it resize grips.
  if (frameRect) {
    const [x, y, bw, bh] = panelBox(state, frameRect)
    ctx.strokeStyle = '#f2edb8'
    ctx.lineWidth = Math.max(3, w / 400)
    ctx.strokeRect(x, y, bw, bh)
    const g = Math.max(10, w / 90)
    ctx.fillStyle = '#f2edb8'
    ctx.strokeStyle = '#17171b'
    ctx.lineWidth = Math.max(1.5, w / 900)
    for (const [, hx, hy] of HANDLES) {
      const cx = x + hx * bw, cy = y + hy * bh
      ctx.fillRect(cx - g / 2, cy - g / 2, g, g)
      ctx.strokeRect(cx - g / 2, cy - g / 2, g, g)
    }
  }
}

// currentTime is async -- wait for the seeks, or frame one records stale pixels.
// Only waits on elements that actually needed moving: waiting on a video already
// at the right spot means no 'seeked' ever fires and we burn the whole timeout,
// which during an export is recorded as a frozen frame.
export function seekAll(state, t) {
  sync(state, t, false)
  const waits = []
  for (const clip of clipsAt(state, t)) {
    const m = pool.get(clip.id)
    if (!m || m.video.readyState < 1) continue
    const want = clip.in + (t - clip.start)
    if (Math.abs(m.video.currentTime - want) < 0.05) continue // already there
    waits.push(new Promise((res) => {
      const done = () => { clearTimeout(bail); m.video.removeEventListener('seeked', done); res() }
      const bail = setTimeout(done, 1200)
      m.video.addEventListener('seeked', done)
      m.video.currentTime = want
    }))
  }
  return Promise.all(waits)
}

export const resume = () => audio().resume()

const MIME = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm']
  .find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm'

// Record the timeline in realtime, then hand the blob to FreeConvert.
// ponytail: realtime capture, tab must stay visible. Swap this one function for a
// server-side ffmpeg filter_complex if frame-exactness or speed ever matters.
export async function exportVideo(canvas, state, run, onStatus, opts = {}) {
  const dur = totalDur(state)
  if (!dur) throw new Error('nothing on the timeline')

  // MediaRecorder records wall-clock, so every millisecond between start() and
  // the first moving frame lands in the file as a freeze. Everything that can
  // block -- audio resume, seeking, decoding frame 0 -- happens before start().
  await resume()
  await seekAll(state, 0)
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))

  const stream = canvas.captureStream(30)
  for (const track of streamDest.stream.getAudioTracks()) stream.addTrack(track)

  const chunks = []
  const rec = new MediaRecorder(stream, { mimeType: MIME, videoBitsPerSecond: 20_000_000 })
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  const stopped = new Promise((res) => (rec.onstop = res))

  const t0 = performance.now()
  rec.start(250)
  await run(dur, onStatus) // caller just plays; nothing here may block first
  rec.stop()
  await stopped
  const wall = (performance.now() - t0) / 1000
  if (wall > dur + 0.6) {
    onStatus(`recorded ${wall.toFixed(1)}s for a ${dur.toFixed(1)}s timeline — playback couldn't keep up`)
  }

  const ext = MIME.startsWith('video/mp4') ? 'mp4' : 'webm'
  const blob = new Blob(chunks, { type: MIME })

  // Three steps, none of which sends the video through our own server: mint the
  // job (the key lives there), upload straight to FreeConvert, then poll. Polling
  // from the browser also means no host request timeout can cut a long job short.
  onStatus(`recorded ${(blob.size / 1e6).toFixed(1)}MB — starting job…`)
  const job = await fetch(`/api/job?${new URLSearchParams({ ext, ...opts })}`, { method: 'POST' })
    .then((r) => r.json().then((j) => (r.ok ? j : Promise.reject(new Error(j.error || 'could not start job')))))

  onStatus(`uploading ${(blob.size / 1e6).toFixed(1)}MB…`)
  const fd = new FormData()
  for (const [k, v] of Object.entries(job.upload.parameters || {})) fd.append(k, v)
  fd.append('file', blob, `input.${ext}`)
  const up = await fetch(job.upload.url, { method: 'POST', body: fd })
  if (!up.ok) throw new Error(`upload failed (${up.status})`)

  for (let i = 0; i < 600; i++) {
    await new Promise((r) => setTimeout(r, 2000))
    const s = await fetch(`/api/job?id=${encodeURIComponent(job.id)}`).then((r) => r.json())
    if (s.status === 'completed') return { url: s.url, raw: blob }
    if (s.status === 'failed') throw new Error(s.error || 'compression failed')
    onStatus(`compressing — ${s.status}… (${i * 2}s)`)
  }
  throw new Error('timed out after 20 minutes')
}
