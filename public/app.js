import { LAYOUTS } from './layouts.js'
import * as R from './render.js'
import * as store from './store.js'
import { separateRows, freeStart, rowLimits } from './arrange.js'
import { icon, iconEl } from './icons.js'

const $ = (s) => document.querySelector(s)
const canvas = $('#canvas')
const ctx = canvas.getContext('2d')
const uid = () => Math.random().toString(36).slice(2, 9)
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi)
const fmt = (s) =>
  Number.isFinite(s) ? `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}` : '--'
const bytes = (n) =>
  n < 1e6 ? `${Math.round(n / 1e3)}KB` : n < 1e9 ? `${Math.round(n / 1e6)}MB` : `${(n / 1e9).toFixed(1)}GB`
const tc = (s) => ((Number.isFinite(s) ? s : 0) < 0 ? '00:00:00'
  : [Math.floor(s / 60), Math.floor(s % 60), Math.floor((s % 1) * 30)]
      .map((n) => String(n).padStart(2, '0')).join(':'))

const ROWH = 50 // row height + gap, must match the CSS

// A clip owns its own place on the timeline: which row, when it starts, how long
// it runs, and where it lands in the frame. Nothing is tied to anything else, so
// clips overlap however you like.
const newClip = (srcId, row, start, dur) => ({
  id: uid(), srcId, row, start, dur,
  in: 0, rect: null, zoom: 1, panX: 0, panY: 0, gain: 1, muted: false,
})

// `grid` remembers the applied layout, so its empty slots stay valid drop targets.
// One factory, so a new project and a cleared project start identically.
const BLANK = () => ({
  id: null,
  title: 'Untitled project',
  sources: [],
  clips: [],
  out: { w: 1080, h: 1920 },
  sel: null,
  // `grid` remembers the applied layout, so its empty slots stay valid drop targets.
  grid: null,
  gap: 0,
  pad: 0,
  radius: 0,
  bg: '#000000',
  bgImg: null, // id of a backdrop image in the file store
  // `auto` records the last name derived from the project title, so an untouched
  // filename keeps following it and a hand-set one doesn't.
  xp: { name: 'edit', auto: 'edit', mode: 'quality', crf: 21, mb: 25,
        codec: 'libx264', speed: 'veryfast' },
})
let state = BLANK()
let t = 0, playing = false, busy = false, tab = 'media', pps = 46, filter = ''
let mode = 'crop' // 'crop' pans inside a clip; 'frame' moves and resizes its panel
const undo = [], redo = []

const persist = () => store.save(state, (e) =>
  setStatus(`couldn't save project: ${e?.name === 'QuotaExceededError' ? 'out of storage space' : e}`, true))

// Rows only exist where clips are: compact them so an emptied row disappears,
// then hold the one-sequence-per-row invariant.
function normalize() {
  const used = [...new Set(state.clips.map((c) => c.row))].sort((a, b) => a - b)
  const remap = new Map(used.map((r, i) => [r, i]))
  for (const c of state.clips) c.row = remap.get(c.row)
  separateRows(state.clips)
  R.dropStale(state)
}

const snapshot = () => {
  undo.push(structuredClone(state))
  if (undo.length > 60) undo.shift()
  redo.length = 0
}
function mutate(fn) { snapshot(); fn(); normalize(); ui(); persist() }

const curClip = () => state.clips.find((c) => c.id === state.sel) || null
const rowCount = () => (state.clips.length ? Math.max(...state.clips.map((c) => c.row)) + 1 : 1)
const srcById = (id) => state.sources.find((s) => s.id === id)
const clipTail = (c) => { const s = srcById(c.srcId); return s ? Math.max(0.2, s.dur - c.in) : Infinity }
const rectEq = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-6)

// With a grid on, a clip added afterwards must take a free slot. Otherwise it
// keeps rect:null, renders full-frame, and sits behind the grid instead of in it.
// Which grid slot a clip occupies, or -1 when it's a plain full-frame layer.
function slotIndex(clip) {
  if (!state.grid || !clip.rect) return -1
  return LAYOUTS[state.grid].findIndex((r) => rectEq(clip.rect, r))
}

function freeSlot(at, dur) {
  if (!state.grid) return null
  const sharing = state.clips.filter((c) => c.start < at + dur && c.start + c.dur > at)
  return LAYOUTS[state.grid].find((r) => !sharing.some((c) => rectEq(c.rect, r))) ?? null
}

function setStatus(msg, err) {
  const el = $('#status')
  el.className = err ? 'err' : ''
  el.innerHTML = msg
}

// Free positioning is unusable without snapping, so pull to nearby edges.
function snap(v, exceptId) {
  const tol = 8 / pps
  let best = v, bestD = tol
  const targets = [0, t]
  for (const c of state.clips) {
    if (c.id === exceptId) continue
    targets.push(c.start, c.start + c.dur)
  }
  for (const p of targets) {
    const d = Math.abs(p - v)
    if (d < bestD) { bestD = d; best = p }
  }
  return Math.max(0, best)
}

// ---- import -------------------------------------------------------------

const once = (el, ev) => new Promise((r) => el.addEventListener(ev, r, { once: true }))
const after = (ms) => new Promise((r) => setTimeout(r, ms))

// Duration, size and a poster frame in one pass. Browser-recorded WebM reports
// duration:Infinity until you seek past the end -- our own exports included, so
// every import goes through this.
async function probe(url) {
  const v = document.createElement('video')
  Object.assign(v, { preload: 'metadata', muted: true, src: url })
  const dead = { dur: 0, w: 0, h: 0, thumb: '' }
  try {
    const ok = await Promise.race([
      once(v, 'loadedmetadata').then(() => 1), once(v, 'error').then(() => 0), after(8000).then(() => 0),
    ])
    if (!ok) return dead
    let dur = v.duration
    if (!Number.isFinite(dur)) {
      v.currentTime = 1e6
      await Promise.race([once(v, 'seeked'), after(4000)])
      dur = v.duration
    }
    if (!Number.isFinite(dur) || !dur) return dead
    const { videoWidth: w, videoHeight: h } = v
    v.currentTime = Math.min(dur * 0.1, Math.max(0, dur - 0.05))
    await Promise.race([once(v, 'seeked'), after(4000)])
    const cv = Object.assign(document.createElement('canvas'),
      { width: 200, height: Math.round((200 * h) / w) || 112 })
    cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height)
    return { dur, w, h, thumb: cv.toDataURL('image/jpeg', 0.65) }
  } catch {
    return dead
  }
}

async function addFiles(files) {
  setStatus(`reading ${files.length} file(s)…`)
  let added = 0
  for (const f of files) {
    const url = URL.createObjectURL(f)
    const meta = await probe(url)
    if (!meta.dur) { setStatus(`couldn't read ${f.name}`, true); continue }
    const id = uid()
    state.sources.push({ id, name: f.name, url, ...meta })
    await store.rememberFile(id, f).catch((e) =>
      setStatus(`loaded, but couldn't be saved for next time: ${e}`, true))
    added++
  }
  // Imports stay in Media. Putting one on the timeline is always an explicit act.
  setStatus(added ? `${added} clip(s) added to Media` : '')
  mutate(() => {})
}

// ---- clips --------------------------------------------------------------

// Removing a source has to take its clips with it, or the timeline is left
// pointing at footage that no longer exists.
async function removeSource(id) {
  const src = srcById(id)
  if (!src) return
  const used = state.clips.filter((c) => c.srcId === id).length
  if (used && !confirm(
    `Remove ${src.name}? It is used by ${used} clip${used > 1 ? 's' : ''} on the timeline, which will go too.`)) return

  mutate(() => {
    for (const c of state.clips.filter((c) => c.srcId === id)) R.dropClip(c.id)
    state.clips = state.clips.filter((c) => c.srcId !== id)
    state.sources = state.sources.filter((s) => s.id !== id)
    if (!state.clips.some((c) => c.id === state.sel)) state.sel = state.clips[0]?.id ?? null
  })
  URL.revokeObjectURL(src.url)
  // Not forgetFile: a duplicated project may share this file. Write the doc first
  // so the sweep sees the removal, then let gc decide whether anyone still wants it.
  await store.flush(state).then(() => store.gc()).catch(() => {})
  projects = await store.listProjects()
  setStatus(`removed ${src.name}${used ? ` and ${used} clip(s)` : ''}`)
}


function addClip(srcId, row = rowCount(), start = null) {
  const src = srcById(srcId)
  if (!src) return
  mutate(() => {
    const at = start ?? state.clips.filter((c) => c.row === row)
      .reduce((m, c) => Math.max(m, c.start + c.dur), 0)
    const clip = newClip(srcId, row, Math.max(0, at), src.dur)
    clip.start = freeStart(state.clips, clip, clip.start, row)
    const slot = freeSlot(clip.start, clip.dur)
    if (slot) clip.rect = [...slot]
    state.clips.push(clip)
    state.sel = clip.id
  })
}

function deleteClip() {
  const clip = curClip()
  if (!clip) return
  mutate(() => {
    state.clips = state.clips.filter((c) => c.id !== clip.id)
    R.dropClip(clip.id)
    state.sel = state.clips[0]?.id ?? null
  })
}

function duplicateClip() {
  const clip = curClip()
  if (!clip) return
  mutate(() => {
    const copy = { ...structuredClone(clip), id: uid(), start: clip.start + clip.dur }
    state.clips.push(copy)
    state.sel = copy.id
  })
}

// Split the selected clip where the playhead crosses it.
function splitAtPlayhead() {
  const clip = curClip() ?? R.clipsAt(state, t)[0]
  if (!clip || t <= clip.start + 0.1 || t >= clip.start + clip.dur - 0.1) return
  mutate(() => {
    const cut = t - clip.start
    const tail = { ...structuredClone(clip), id: uid(), start: t, in: clip.in + cut, dur: clip.dur - cut }
    clip.dur = cut
    state.clips.push(tail)
    state.sel = tail.id
  })
}

// A grid layout is a preset: it hands the clips under the playhead a rect each,
// and pins them to the window where they all actually coexist. Without that, the
// shortest clip runs out mid-grid and leaves a dead panel behind.
function applyLayout(name) {
  const rects = LAYOUTS[name]
  const here = R.clipsAt(state, t).slice().sort((a, b) => a.row - b.row)
  if (!here.length) return setStatus('move the playhead over some clips first', true)

  const from = Math.max(...here.map((c) => c.start))
  const dur = Math.max(0.2, Math.min(...here.map((c) => c.start + c.dur)) - from)

  if (here.length > rects.length) {
    return setStatus(
      `${name} has ${rects.length} slots but ${here.length} clips are under the playhead — pick a bigger grid`, true)
  }
  mutate(() => {
    state.grid = name
    here.forEach((c, i) => {
      const live = state.clips.find((x) => x.id === c.id)
      if (!live) return
      live.rect = rects[i] ? [...rects[i]] : null
      // Advance the in-point by whatever we trim off the head, so the footage
      // stays lined up with the timeline.
      live.in += from - live.start
      live.start = from
      live.dur = dur
    })
  })
  setStatus(`${name} applied to ${here.length} clip(s), all held to ${dur.toFixed(1)}s`)
}

const clearRects = () => mutate(() => {
  state.grid = null
  for (const c of R.clipsAt(state, t)) {
    const live = state.clips.find((x) => x.id === c.id)
    if (live) live.rect = null
  }
})

// ---- transport ----------------------------------------------------------

async function play() {
  if (!R.totalDur(state)) return
  await R.resume()
  if (t >= R.totalDur(state) - 0.01) await seek(0)
  playing = true
  $('#play').innerHTML = icon('pause', 16)
}
function pause() { playing = false; $('#play').innerHTML = icon('play', 16) }

async function seek(to) {
  t = clamp(to, 0, R.totalDur(state))
  await R.seekAll(state, t)
  syncHead()
}

function syncHead() {
  $('#head').style.left = `${t * pps}px`
  $('#tnow').textContent = tc(t)
  $('#ttot').textContent = tc(R.totalDur(state))
}

function loop(now) {
  requestAnimationFrame(loop)
  const dt = Math.min((now - (loop.prev || now)) / 1000, 0.25)
  loop.prev = now
  if (playing) {
    t += dt
    if (t >= R.totalDur(state)) { t = R.totalDur(state); pause() }
    syncHead()
  }
  R.sync(state, t, playing)
  const framed = mode === 'frame' && curClip()
  R.draw(ctx, state, t, hoverRect, framed ? (framed.rect ?? [0, 0, 1, 1]) : null)
}

// ---- ui helpers ---------------------------------------------------------

function el(tag, props = {}, kids = []) {
  const n = Object.assign(document.createElement(tag), props)
  n.append(...kids)
  return n
}

let openDD = null
const closeDD = () => { openDD?.(); openDD = null }

// Native <select> can't style its popup, so this renders the list into <body>
// with fixed positioning -- otherwise the panel's overflow clips it.
function dropdown({ value, options, onChange, label = 'Select', wide }) {
  const cur = options.find((o) => o.value === value)
  const btn = el('button', { className: 'ddbtn', type: 'button' })
  btn.setAttribute('aria-expanded', 'false')
  btn.append(el('span', { textContent: cur ? cur.label : label }))
  const chev = el('i', { className: 'ddchev' })
  chev.innerHTML = icon('chevron', 14)
  btn.append(chev)
  const wrap = el('div', { className: 'dd' }, [btn])
  if (wide) wrap.style.width = '100%'

  const open = () => {
    closeDD()
    const list = el('div', { className: 'ddlist', role: 'listbox' })
    const r = btn.getBoundingClientRect()
    let active = Math.max(0, options.findIndex((o) => o.value === value))
    const items = options.map((o, i) => {
      const item = el('div', { className: 'ddopt' + (o.value === value ? ' on' : ''), role: 'option' })
      if (o.sep) list.append(el('div', { className: 'ddsep' }))
      if (o.swatch) item.append(el('span', { className: 'sw', style: o.swatch }))
      item.append(el('span', { textContent: o.label }))
      if (o.meta) item.append(el('small', { textContent: o.meta }))
      item.append(el('span', { className: 'tick', textContent: '✓' }))
      item.onclick = () => { closeDD(); onChange(o.value) }
      item.onpointerenter = () => setActive(i)
      list.append(item)
      return item
    })
    const setActive = (i) => {
      active = (i + items.length) % items.length
      items.forEach((n, j) => n.classList.toggle('active', j === active))
      items[active]?.scrollIntoView({ block: 'nearest' })
    }
    setActive(active)

    document.body.append(list)
    const h = list.offsetHeight
    list.style.minWidth = `${Math.max(r.width, 190)}px`
    list.style.left = `${Math.min(r.left, innerWidth - list.offsetWidth - 8)}px`
    list.style.top = innerHeight - r.bottom - 8 < h && r.top > h ? `${r.top - h - 6}px` : `${r.bottom + 6}px`
    btn.setAttribute('aria-expanded', 'true')

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); closeDD(); btn.focus() }
      else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1) }
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); closeDD(); onChange(options[active].value) }
    }
    const onOutside = (e) => { if (!list.contains(e.target) && e.target !== btn) closeDD() }
    addEventListener('keydown', onKey, true)
    addEventListener('pointerdown', onOutside, true)
    addEventListener('resize', closeDD)
    addEventListener('scroll', closeDD, true)
    openDD = () => {
      removeEventListener('keydown', onKey, true)
      removeEventListener('pointerdown', onOutside, true)
      removeEventListener('resize', closeDD)
      removeEventListener('scroll', closeDD, true)
      list.remove()
      btn.setAttribute('aria-expanded', 'false')
    }
  }
  btn.onclick = (e) => {
    e.stopPropagation()
    btn.getAttribute('aria-expanded') === 'true' ? closeDD() : open()
  }
  return wrap
}


function layoutIcon(name) {
  const box = el('div', { className: 'lico' })
  box.style.aspectRatio = `${state.out.w} / ${state.out.h}`
  for (const [x, y, w, h] of LAYOUTS[name]) {
    box.append(el('i', { style: `left:${x * 100}%;top:${y * 100}%;width:${w * 100}%;height:${h * 100}%` }))
  }
  return box
}

// ---- rail + panels ------------------------------------------------------

const TABS = [['projects', 'Projects'], ['media', 'Media'], ['layout', 'Grid'],
              ['adjust', 'Adjust'], ['output', 'Output']]
const SIZES = [
  { value: '1080x1920', label: 'Vertical · 1080×1920', swatch: 'aspect-ratio:9/16;height:18px;width:auto' },
  { value: '1080x1080', label: 'Square · 1080×1080', swatch: 'aspect-ratio:1;height:18px;width:auto' },
  { value: '1920x1080', label: 'Landscape · 1920×1080', swatch: 'aspect-ratio:16/9;width:24px;height:auto' },
]

function drawSizeDD() {
  $('#sizedd').replaceChildren(dropdown({
    value: `${state.out.w}x${state.out.h}`,
    options: SIZES,
    onChange: (v) => {
      const [w, h] = v.split('x').map(Number)
      mutate(() => { state.out = { w, h } })
    },
  }))
}

function drawRail() {
  const rail = $('#rail')
  rail.replaceChildren(el('span', { className: 'logo', textContent: 'editz' }))
  for (const [key, label] of TABS) {
    const b = el('button', { className: tab === key ? 'on' : '', title: label })
    b.innerHTML = icon(key, 20) + `<span>${label}</span>`
    b.onclick = () => { tab = key; drawRail(); drawPanel() }
    rail.append(b)
  }
}

// How long ago, in the roughest units that still say something useful.
function ago(ms) {
  if (!ms) return 'never opened'
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 90) return 'just now'
  const m = s / 60
  if (m < 60) return `${Math.round(m)} min ago`
  const h = m / 60
  if (h < 24) return `${Math.round(h)}h ago`
  return `${Math.round(h / 24)}d ago`
}

function panelProjects(p) {
  p.append(el('label', { textContent: 'Projects' }))
  const add = el('button', { id: 'add', textContent: '+ New project' })
  add.onclick = createProject
  p.append(add)

  if (!projects.length) {
    p.append(el('div', { className: 'hint', textContent: 'No saved projects yet.' }))
    return
  }

  for (const pr of projects) {
    const here = pr.id === state.id
    const acts = el('div', { className: 'acts' })

    const dup = el('button', { title: `Duplicate ${pr.title}` })
    dup.innerHTML = icon('copy', 15)
    dup.onclick = async (e) => {
      e.stopPropagation()
      if (here) await store.flush(state) // copy what's on screen, not the last save
      const id = await store.duplicateProject(pr.id, `${pr.title} copy`, Date.now())
      projects = await store.listProjects()
      ui()
      setStatus(`duplicated to "${pr.title} copy"`)
      return id
    }

    const rm = el('button', { className: 'danger', title: `Delete ${pr.title}` })
    rm.innerHTML = icon('trash', 15)
    rm.onclick = (e) => { e.stopPropagation(); removeProject(pr.id) }

    acts.append(dup)
    if (projects.length > 1) acts.append(rm)

    const card = el('div', { className: 'pcard' + (here ? ' on' : '') }, [
      iconEl(here ? 'media' : 'projects', 17),
      el('div', { className: 'grow' }, [
        el('b', { textContent: pr.title || 'Untitled project' }),
        el('small', {
          textContent: `${pr.clips} clip${pr.clips === 1 ? '' : 's'} · `
            + `${pr.sources} file${pr.sources === 1 ? '' : 's'} · ${ago(pr.updated)}`,
        }),
      ]),
      acts,
    ])
    card.onclick = () => openProject(pr.id)
    p.append(card)
  }

  p.append(el('div', { className: 'hint', textContent:
    'Projects live in this browser, not on a server. Duplicating one costs no extra space — both point at the same video files.' }))
}

function panelMedia(p) {
  p.append(el('label', { textContent: 'Media' }))
  const add = el('button', { id: 'add', textContent: '+ Add videos' })
  add.onclick = () => $('#file').click()
  p.append(add)

  if (!state.sources.length) {
    p.append(el('div', { className: 'hint', textContent:
      'Add videos to begin, or drop them anywhere in the window. Nothing lands on the timeline until you put it there.' }))
    return
  }
  const search = el('input', { id: 'search', type: 'text', placeholder: 'Search clips', value: filter })
  search.oninput = () => { filter = search.value; drawPanel(); $('#search').focus() }
  p.append(search)

  const grid = el('div', { className: 'mgrid' })
  const shown = state.sources.filter((s) => s.name.toLowerCase().includes(filter.toLowerCase()))
  for (const s of shown) {
    const plus = el('button', { className: 'madd', title: 'Add to a new row' })
    plus.innerHTML = icon('plus', 15)
    plus.onclick = (e) => { e.stopPropagation(); addClip(s.id) }
    const del = el('button', { className: 'madd mdel', title: `Remove ${s.name} from this project` })
    del.innerHTML = icon('x', 15)
    del.onclick = (e) => { e.stopPropagation(); removeSource(s.id) }
    for (const b of [plus, del]) b.draggable = false // don't drag the thumbnail beneath
    const item = el('div', {
      className: 'mitem', draggable: true,
      title: `${s.name} — drag onto the timeline, anywhere you like`,
    }, [
      el('img', { src: s.thumb, alt: '' }), plus, del,
      el('b', { textContent: s.name.replace(/\.[^.]+$/, '') }),
      el('small', { textContent: `${fmt(s.dur)} · ${s.w}×${s.h}` }),
    ])
    item.onclick = () => addClip(s.id)
    item.ondragstart = (e) => {
      e.dataTransfer.setData(SRC_MIME, s.id)
      e.dataTransfer.effectAllowed = 'copy'
    }
    grid.append(item)
  }
  p.append(grid)
  if (!shown.length) p.append(el('div', { className: 'hint', textContent: 'No clips match.' }))
  p.append(el('div', { className: 'hint', textContent:
    'Drop a clip anywhere on a row — it starts where you drop it. The + adds it on a new row.' }))
}

function panelLayout(p) {
  p.append(el('label', { textContent: 'Grid layout' }))
  const here = R.clipsAt(state, t)
  p.append(el('div', { className: 'hint', textContent: here.length
    ? `Applies to the ${here.length} clip(s) under the playhead, top row first.`
    : 'Move the playhead over some clips, then pick a layout.' }))

  const grid = el('div', { className: 'lgrid' })
  for (const name of Object.keys(LAYOUTS)) {
    const item = el('div', { className: 'litem' }, [layoutIcon(name), el('span', { textContent: name })])
    item.onclick = () => applyLayout(name)
    grid.append(item)
  }
  p.append(grid)

  const reset = el('button', { textContent: 'Full frame (clear grid)', style: 'margin-top:10px;width:100%' })
  reset.onclick = clearRects
  p.append(reset)
  p.append(el('div', { className: 'hint', textContent:
    'Full frame stacks clips instead: row 1 covers the rows below it.' }))
  if (here.length > 9) {
    p.append(el('div', { className: 'hint warn', textContent:
      `${here.length} videos decode at once here. Recording is realtime, so expect dropped frames.` }))
  }
}

function panelAdjust(p) {
  const clip = curClip()
  if (!clip) { p.append(el('div', { className: 'hint', textContent: 'Select a clip on the timeline.' })); return }
  const src = srcById(clip.srcId)

  p.append(el('label', { textContent: 'Clip' }))
  p.append(dropdown({
    wide: true, value: clip.srcId,
    options: state.sources.map((v) => ({ value: v.id, label: v.name })),
    onChange: (v) => mutate(() => { clip.srcId = v; clip.dur = Math.min(clip.dur, clipTail(clip)) }),
  }))

  const num = (labelText, value, step, onSet) => {
    p.append(el('label', { textContent: labelText }))
    const i = el('input', { type: 'number', step, value: value.toFixed(2) })
    i.onchange = () => mutate(() => onSet(+i.value))
    p.append(i)
  }
  num('Starts at (s)', clip.start, '0.1', (v) => { clip.start = Math.max(0, v) })
  num('Length (s)', clip.dur, '0.1', (v) => { clip.dur = clamp(v, 0.2, clipTail(clip)) })
  num(`Start in clip — of ${fmt(src?.dur ?? 0)}`, clip.in, '0.5', (v) => {
    clip.in = clamp(v, 0, src?.dur ?? 0)
    clip.dur = Math.min(clip.dur, clipTail(clip))
  })

  const rect = clip.rect ?? [0, 0, 1, 1]
  const NAMES = ['X', 'Y', 'Width', 'Height']
  p.append(el('label', { textContent: `Panel — % of frame${slotIndex(clip) >= 0 ? ` · grid slot ${slotIndex(clip) + 1}` : ''}` }))
  const row = el('div', { style: 'display:grid;grid-template-columns:1fr 1fr;gap:6px' })
  rect.forEach((v, i) => {
    const box = el('div')
    box.append(el('div', { textContent: NAMES[i], style: 'font-size:9.5px;color:var(--dim);margin-bottom:3px' }))
    const inp = el('input', { type: 'number', step: '1', min: '0', max: '100', value: Math.round(v * 100) })
    inp.onchange = () => mutate(() => {
      const next = [...(clip.rect ?? [0, 0, 1, 1])]
      next[i] = clamp(+inp.value / 100, i < 2 ? 0 : MINR, 1)
      // keep the panel inside the frame whichever edge moved
      if (i === 0) next[2] = Math.min(next[2], 1 - next[0])
      if (i === 1) next[3] = Math.min(next[3], 1 - next[1])
      if (i === 2) next[0] = Math.min(next[0], 1 - next[2])
      if (i === 3) next[1] = Math.min(next[1], 1 - next[3])
      clip.rect = next
    })
    box.append(inp)
    row.append(box)
  })
  p.append(row)
  const full = el('button', { textContent: 'Fill frame', style: 'margin-top:8px;width:100%' })
  full.onclick = () => mutate(() => { clip.rect = null })
  p.append(full)
  p.append(el('div', { className: 'hint', textContent: mode === 'frame'
    ? 'Frame mode: drag the panel to move it, corners to resize.'
    : 'Switch to Frame above the timeline to drag this panel around the preview.' }))

  const zlab = el('label', { textContent: `Crop zoom ${clip.zoom.toFixed(2)}×` })
  const zoom = el('input', { type: 'range', min: '1', max: '5', step: '0.01', value: clip.zoom })
  zoom.oninput = () => { clip.zoom = +zoom.value; zlab.textContent = `Crop zoom ${clip.zoom.toFixed(2)}×` }
  zoom.onchange = persist
  p.append(zlab, zoom)
  const reset = el('button', { textContent: 'Reset crop', style: 'margin-top:8px;width:100%' })
  reset.onclick = () => mutate(() => Object.assign(clip, { zoom: 1, panX: 0, panY: 0 }))
  p.append(reset)

  const vlab = el('label', { textContent: `Volume ${Math.round(clip.gain * 100)}%` })
  const vol = el('input', { type: 'range', min: '0', max: '1.5', step: '.01', value: clip.gain })
  vol.oninput = () => { clip.gain = +vol.value; vlab.textContent = `Volume ${Math.round(clip.gain * 100)}%` }
  vol.onchange = persist
  p.append(vlab, vol)
  const mute = el('button', { textContent: clip.muted ? 'Unmute' : 'Mute',
    className: clip.muted ? 'on' : '', style: 'margin-top:8px;width:100%' })
  mute.onclick = () => mutate(() => { clip.muted = !clip.muted })
  p.append(mute)
  p.append(el('div', { className: 'hint', textContent: 'Drag the preview to pan the crop, scroll to zoom.' }))
}

function panelOutput(p) {
  p.append(el('label', { textContent: 'Output' }))
  p.append(el('div', { className: 'hint', textContent:
    `${state.out.w}×${state.out.h} · ${fmt(R.totalDur(state))} · ${state.clips.length} clip(s)` }))

  // Label, filled bar, and a number box that edits the same value both ways.
  // Rebuilding the panel mid-drag would replace the very input being dragged, so
  // these update each other in place. The canvas repaints from the rAF loop.
  const slider = (labelText, key, max) => {
    const bar = el('input', { type: 'range', className: 'fslider',
      min: '0', max: String(max), step: '1', value: state[key] })
    const num = el('input', { type: 'number', className: 'ctl-num',
      min: '0', max: String(max), step: '1', value: state[key] })
    const set = (v, from) => {
      state[key] = clamp(Math.round(v) || 0, 0, max)
      if (from !== bar) { bar.value = state[key]; paintRange(bar) }
      if (from !== num) num.value = state[key]
    }
    bar.oninput = () => set(+bar.value, bar)
    num.oninput = () => set(+num.value, num) // permissive while typing...
    num.onchange = () => { num.value = state[key]; persist() } // ...tidied on commit
    bar.onchange = persist
    p.append(el('div', { className: 'ctl' },
      [el('span', { className: 'ctl-label', textContent: labelText }), bar, num]))
  }

  p.append(el('label', { textContent: 'Layout' }))
  slider('Gap', 'gap', 160)
  slider('Padding', 'pad', 240)
  slider('Corners', 'radius', 120)

  p.append(el('label', { textContent: 'Background' }))
  const row = el('div', { className: 'bgrow' })
  const pick = el('input', { type: 'color', value: state.bg, title: 'Custom colour' })
  pick.oninput = () => { state.bg = pick.value; drawSwatches() }
  pick.onchange = persist
  const swatches = el('div', { className: 'swatches' })
  const drawSwatches = () => {
    swatches.replaceChildren()
    for (const c of ['#000000', '#ffffff', '#f2edb8', '#1b2338', '#c0392b']) {
      const b = el('button', { title: c,
        className: 'sw' + (state.bg.toLowerCase() === c && !state.bgImg ? ' on' : ''),
        style: `background:${c}` })
      b.onclick = () => mutate(() => { state.bg = c })
      swatches.append(b)
    }
  }
  drawSwatches()
  row.append(pick, swatches)
  p.append(row)

  // A backdrop image sits behind the panels, cover-fitted like the clips are.
  const imgRow = el('div', { style: 'display:flex;gap:6px;margin-top:8px' })
  const upload = el('button', { textContent: state.bgImg ? 'Replace image' : 'Use an image',
    style: 'flex:1' })
  upload.onclick = () => $('#bgfile').click()
  imgRow.append(upload)
  if (state.bgImg) {
    const clear = el('button', { title: 'Remove the backdrop image', style: 'flex:0 0 auto' })
    clear.innerHTML = icon('x', 15)
    clear.onclick = () => mutate(() => {
      state.bgImg = null
      R.setBackdrop(null)
    })
    imgRow.append(clear)
  }
  p.append(imgRow)

  p.append(el('label', { textContent: 'Storage' }))
  const used = el('div', { className: 'hint', textContent: 'checking…' })
  p.append(used)
  store.usage().then((u) => {
    used.textContent = u
      ? `${state.sources.length} file(s) · ${bytes(u.used)} of ${bytes(u.quota)}`
      : `${state.sources.length} file(s) on this device`
  })

  const wipe = el('button', { textContent: 'Empty this project', style: 'margin-top:8px;width:100%' })
  wipe.onclick = async () => {
    if (!confirm(`Remove every clip from "${state.title}"? Other projects are untouched.`)) return
    for (const src of state.sources) URL.revokeObjectURL(src.url)
    R.dropAll()
    // keep id, title and look; drop only the contents
    state = { ...BLANK(), id: state.id, title: state.title, out: state.out,
              gap: state.gap, pad: state.pad, radius: state.radius, bg: state.bg, xp: state.xp }
    undo.length = 0; redo.length = 0
    persist()
    await store.gc() // release files no project references any more
    projects = await store.listProjects()
    setStatus('project emptied')
    ui()
  }
  p.append(wipe)
}

function drawPanel() {
  const p = $('#panel')
  p.replaceChildren()
  ;({ projects: panelProjects, media: panelMedia, layout: panelLayout,
     adjust: panelAdjust, output: panelOutput })[tab](p)
  paintRanges()
}

// ---- drag plumbing ------------------------------------------------------

const SRC_MIME = 'application/x-editz-src'
const hasSrc = (e) => e.dataTransfer.types.includes(SRC_MIME)
const hasFiles = (e) => e.dataTransfer.types.includes('Files')
let hoverRect = null // slot outlined while a clip is dragged across the preview
let dropSlot = -1

const timeAt = (clientX) =>
  Math.max(0, (clientX - $('#inner').getBoundingClientRect().left) / pps)

// Live feedback redraws the timeline every frame, which replaces the very element
// the gesture started on. So drag listeners go on window, never on the block --
// otherwise the first redraw detaches the node and strands the drag.
function dragLoop(onMove, onDone) {
  const move = (ev) => { onMove(ev); drawTimeline() }
  const up = () => {
    removeEventListener('pointermove', move)
    removeEventListener('pointerup', up)
    removeEventListener('pointercancel', up)
    onDone()
  }
  addEventListener('pointermove', move)
  addEventListener('pointerup', up)
  addEventListener('pointercancel', up)
}

// Move a clip: horizontally along the timeline, vertically between rows.
function moveDrag(e, clip) {
  if (e.target.closest('.g')) return // trim grips handle their own drag
  e.preventDefault()
  state.sel = clip.id
  snapshot()
  const x0 = e.clientX, y0 = e.clientY
  const start0 = clip.start, row0 = clip.row

  dragLoop(
    (ev) => {
      const row = Math.max(0, row0 + Math.round((ev.clientY - y0) / ROWH))
      const want = snap(Math.max(0, start0 + (ev.clientX - x0) / pps), clip.id)
      clip.row = row
      clip.start = freeStart(state.clips, clip, want, row)
    },
    () => { normalize(); ui(); persist() },
  )
}

// Trim an edge. Either edge can shorten or lengthen; the left one moves the start
// and the in-point together so the footage under the cursor stays put.
function trimDrag(e, clip) {
  e.preventDefault(); e.stopPropagation()
  const left = e.target.classList.contains('l')
  state.sel = clip.id
  snapshot()
  const x0 = e.clientX, start0 = clip.start, dur0 = clip.dur, in0 = clip.in

  dragLoop(
    (ev) => {
      const d = (ev.clientX - x0) / pps
      const { prevEnd, nextStart } = rowLimits(state.clips, clip)
      if (!left) {
        // Shrinks to 0.2s; grows until the footage or the next clip stops it.
        const cap = Math.min(clipTail(clip), nextStart - start0)
        clip.dur = clamp(snap(start0 + dur0 + d, clip.id) - start0, 0.2, cap)
      } else {
        // Can't start before the source, before 0, or inside the previous clip.
        const lo = Math.max(-in0, prevEnd - start0)
        const delta = clamp(snap(start0 + d, clip.id) - start0, lo, dur0 - 0.2)
        clip.start = start0 + delta
        clip.in = in0 + delta
        clip.dur = dur0 - delta
      }
    },
    () => { ui(); persist() },
  )
}

// ---- timeline -----------------------------------------------------------

function drawTimeline() {
  const total = R.totalDur(state)
  const rows = rowCount()
  $('#inner').style.width = `${Math.max(total * pps + 200, 400)}px`
  $('#tlnote').textContent = state.clips.length
    ? (state.grid
        ? `outlined clips fill the ${state.grid} grid · the rest are full-frame layers, row 1 on top`
        : 'drag clips anywhere · edges to trim · row 1 is the top layer')
    : 'drag a clip here from Media, or use the + on a thumbnail'

  const ruler = $('#ruler')
  ruler.replaceChildren()
  const step = pps > 110 ? 1 : pps > 55 ? 2 : pps > 25 ? 5 : 10
  for (let sec = 0; sec <= total + step * 2; sec += step) {
    ruler.append(el('div', { className: 'tick', textContent: fmt(sec), style: `left:${sec * pps}px` }))
  }

  const wrap = $('#lanes')
  wrap.replaceChildren()
  for (let row = 0; row < rows; row++) {
    const lane = el('div', { className: 'lane' })
    for (const clip of state.clips.filter((c) => c.row === row)) {
      const src = srcById(clip.srcId)
      const slot = slotIndex(clip)
      const b = el('div', {
        className: 'blk' + (clip.id === state.sel ? ' on' : '') + (slot >= 0 ? ' ingrid' : ''),
        style: `left:${clip.start * pps}px;width:${Math.max(clip.dur * pps, 16)}px`
             + (src ? `;background-image:url(${src.thumb})` : ''),
        title: src
          ? `${src.name} · ${fmt(clip.start)} → ${fmt(clip.start + clip.dur)}`
            + (slot >= 0 ? ` · grid slot ${slot + 1} of ${state.grid}` : ' · full-frame layer')
          : '',
      }, [
        el('span', { className: 'g l', textContent: '‹' }),
        el('span', { className: 'lbl', textContent: (src?.name ?? '?').replace(/\.[^.]+$/, '') }),
        ...(slot >= 0 ? [el('span', { className: 'slot', textContent: String(slot + 1) })] : []),
        el('span', { className: 'g r', textContent: '›' }),
      ])
      b.onpointerdown = (e) => moveDrag(e, clip)
      b.onclick = () => { state.sel = clip.id; ui() }
      for (const g of b.querySelectorAll('.g')) g.onpointerdown = (e) => trimDrag(e, clip)
      wireDrop(b, row)
      lane.append(b)
    }
    if (!state.clips.length) {
      lane.append(el('div', { className: 'blk empty', style: 'left:0;right:0;width:auto',
        textContent: 'Drop a clip here' }))
    }
    wireDrop(lane, row)
    wrap.append(lane)
  }

  const ghost = el('div', { className: 'lane ghost' }, [el('span', { textContent: 'drop here to add a row' })])
  wireDrop(ghost, rows)
  wrap.append(ghost)

  const heads = $('#headsin')
  heads.replaceChildren(el('div', { style: 'height:31px' })) // ruler
  for (let row = 0; row < rows; row++) {
    const inRow = state.clips.filter((c) => c.row === row)
    const allMuted = inRow.length > 0 && inRow.every((c) => c.muted)
    const btn = el('button', { className: allMuted ? 'on' : '', title: `Mute row ${row + 1}` })
    btn.innerHTML = icon(allMuted ? 'muted' : 'volume', 15)
    btn.onclick = () => mutate(() => inRow.forEach((c) => { c.muted = !allMuted }))
    heads.append(el('div', { className: 'rowh' }, [btn]))
  }
  syncHead()
}

// A clip dropped from Media lands exactly where you let go.
function wireDrop(node, row) {
  node.ondragover = (e) => {
    if (!hasSrc(e)) return
    e.preventDefault()
    node.classList.add('drop')
  }
  node.ondragleave = () => node.classList.remove('drop')
  node.ondrop = (e) => {
    node.classList.remove('drop')
    const srcId = e.dataTransfer.getData(SRC_MIME)
    if (!srcId) return
    e.preventDefault(); e.stopPropagation()
    addClip(srcId, row, snap(timeAt(e.clientX)))
  }
}

// WebKit can't style the filled half of a range, so the track is a gradient and
// this keeps its stop in sync. Measured in px, not %: the thumb only travels
// (width - thumbWidth), so a percentage fill drifts away from the thumb centre.
function paintRange(r) {
  const min = +r.min || 0, max = +r.max || 100
  const frac = ((+r.value - min) / (max - min || 1)) || 0
  const tw = r.classList.contains('fslider') ? 6 : 15
  const w = r.offsetWidth || 0
  r.style.setProperty('--p', `${tw / 2 + frac * Math.max(0, w - tw)}px`)
}
const paintRanges = () => document.querySelectorAll('input[type=range]').forEach(paintRange)
addEventListener('input', (e) => { if (e.target?.type === 'range') paintRange(e.target) }, true)

// Preview canvas is capped by pixel count, not by dimension, so portrait and
// landscape both land near the same cost. Export resets this to 1.
const PREVIEW_PIXELS = 1280 * 720
const previewScale = () =>
  Math.min(1, Math.sqrt(PREVIEW_PIXELS / (state.out.w * state.out.h)))

function ui() {
  closeDD()
  const k = previewScale()
  R.setScale(k)
  canvas.width = Math.round(state.out.w * k)
  canvas.height = Math.round(state.out.h * k)
  $('#undo').disabled = !undo.length
  $('#redo').disabled = !redo.length
  drawRail(); drawPanel(); drawTimeline(); drawSizeDD(); drawName(); drawSwitch()
  paintRanges()
}

// ---- events -------------------------------------------------------------

// ---- project name -------------------------------------------------------

const slug = (s) => (s || '').trim().replace(/[^\w.-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60)

const pname = $('#pname')
function drawName() {
  if (document.activeElement !== pname) pname.value = state.title
  pname.style.width = `${Math.max(String(pname.value).length + 1, 8)}ch`
  document.title = `${state.title} · editz`
}
pname.oninput = () => { state.title = pname.value; drawName() }
pname.onchange = () => {
  state.title = pname.value.trim() || 'Untitled project'
  drawName()
  persist()
}
pname.onkeydown = (e) => { if (e.key === 'Enter' || e.key === 'Escape') pname.blur() }

// Fill the icon slots in the markup. Done here so icons.js stays the only place
// glyphs live, rather than pasting SVG into index.html.
for (const [sel, name] of [['#undo', 'undo'], ['#redo', 'redo'],
                           ['#mcrop i', 'crop'], ['#mframe i', 'frame'],
                           ['#split i', 'split'], ['#dup i', 'copy'], ['#del i', 'trash']]) {
  const n = $(sel)
  if (n) n.innerHTML = icon(name, sel.endsWith('i') ? 14 : 16)
}
$('#play').innerHTML = icon('play', 16)

// ---- projects -----------------------------------------------------------
// Several projects, all in IndexedDB. The picker sits beside the name.

let projects = []

// Swap the whole editor over to another project, releasing this one's blob URLs.
async function openProject(id) {
  if (id === state.id) return
  for (const src of state.sources) URL.revokeObjectURL(src.url)
  R.dropAll()
  const saved = await store.loadProject(id)
  if (!saved) return setStatus("that project could not be opened", true)
  state = { ...BLANK(), ...saved, xp: { ...BLANK().xp, ...(saved.xp ?? {}) } }
  undo.length = 0; redo.length = 0
  await store.setCurrent(id)
  normalize()
  t = 0
  await loadBackdrop()
  projects = await store.listProjects()
  ui()
  setStatus(`opened ${state.title}`)
}

async function createProject() {
  const id = await store.newProject('Untitled project', Date.now())
  for (const src of state.sources) URL.revokeObjectURL(src.url)
  R.dropAll()
  state = { ...BLANK(), id, title: 'Untitled project' }
  R.setBackdrop(null)
  undo.length = 0; redo.length = 0
  t = 0
  projects = await store.listProjects()
  ui()
  setStatus('new project')
}

async function removeProject(id) {
  const p = projects.find((x) => x.id === id)
  if (!confirm(`Delete "${p?.title || 'this project'}" and its clips? This cannot be undone.`)) return
  projects = await store.deleteProject(id)
  if (id === state.id) {
    const next = projects[0]?.id
    if (next) { state.id = null; await openProject(next) }
    else await createProject()
  } else {
    ui()
  }
  setStatus('project deleted')
}

function drawSwitch() {
  const opts = projects.map((p) => ({
    value: p.id,
    label: p.title || 'Untitled project',
    meta: `${p.clips} clip${p.clips === 1 ? '' : 's'}`,
  }))
  opts.push({ value: '__new', label: '+ New project', sep: true })
  if (projects.length > 1) opts.push({ value: '__del', label: `Delete "${state.title}"` })
  $('#pswitch').replaceChildren(dropdown({
    value: state.id, options: opts, label: 'Projects',
    onChange: (v) => {
      if (v === '__new') return createProject()
      if (v === '__del') return removeProject(state.id)
      openProject(v)
    },
  }))
}

$('#file').onchange = (e) => { addFiles([...e.target.files]); e.target.value = '' }
$('#bgfile').onchange = async (e) => {
  const f = e.target.files[0]
  e.target.value = ''
  if (!f) return
  const id = uid()
  try {
    await store.rememberFile(id, f)
  } catch (err) {
    return setStatus(`couldn't save that image: ${err.message || err}`, true)
  }
  mutate(() => { state.bgImg = id })
  R.setBackdrop(URL.createObjectURL(f))
  setStatus(`backdrop set from ${f.name}`)
}

// Re-hydrate the backdrop whenever a project opens.
async function loadBackdrop() {
  if (!state.bgImg) return R.setBackdrop(null)
  const file = await store.readFile(state.bgImg).catch(() => null)
  R.setBackdrop(file ? URL.createObjectURL(file) : null)
}
$('#play').onclick = () => (playing ? pause() : play())
const setMode = (m) => {
  mode = m
  $('#mcrop').classList.toggle('on', m === 'crop')
  $('#mframe').classList.toggle('on', m === 'frame')
  canvas.style.cursor = m === 'frame' ? 'move' : 'grab'
  if (tab === 'adjust') drawPanel()
}
$('#mcrop').onclick = () => setMode('crop')
$('#mframe').onclick = () => setMode('frame')
$('#split').onclick = splitAtPlayhead
$('#dup').onclick = duplicateClip
$('#del').onclick = deleteClip
$('#zoom').oninput = (e) => { pps = +e.target.value; drawTimeline() }
const doUndo = () => { if (undo.length) { redo.push(structuredClone(state)); state = undo.pop(); normalize(); ui(); persist() } }
const doRedo = () => { if (redo.length) { undo.push(structuredClone(state)); state = redo.pop(); normalize(); ui(); persist() } }
$('#undo').onclick = doUndo
$('#redo').onclick = doRedo

let gripAt = null
const grip = $('#grip')
grip.onpointerdown = (e) => {
  gripAt = { y: e.clientY, h: $('#tl').offsetHeight }
  grip.classList.add('on')
  try { grip.setPointerCapture(e.pointerId) } catch {} // window listeners cover it regardless
}
grip.onpointermove = (e) => {
  if (!gripAt) return
  const tl = $('#tl')
  tl.style.maxHeight = 'none'
  tl.style.height = `${clamp(gripAt.h + (gripAt.y - e.clientY), 110, innerHeight * 0.75)}px`
}
grip.onpointerup = grip.onpointercancel = () => { gripAt = null; grip.classList.remove('on') }
grip.ondblclick = () => { $('#tl').style.height = ''; $('#tl').style.maxHeight = '' }

$('#scroll').addEventListener('scroll', (e) => {
  $('#headsin').style.transform = `translateY(${-e.target.scrollTop}px)`
})

// scrub by dragging the ruler or the empty part of a row
let scrubbing = false
const scrubTo = (e) => { pause(); seek(timeAt(e.clientX)) }
for (const id of ['#ruler', '#lanes']) {
  $(id).addEventListener('pointerdown', (e) => {
    if (e.target.closest('.blk')) return
    scrubbing = true
    scrubTo(e)
  })
}
addEventListener('pointermove', (e) => scrubbing && scrubTo(e))
addEventListener('pointerup', () => (scrubbing = false))

// preview: click to select the clip you can see, drag to pan its crop
const clipAt = (e) => {
  const r = canvas.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
  // clipsAt is topmost-last, so scan backwards for what's actually visible
  const here = R.clipsAt(state, t)
  for (let i = here.length - 1; i >= 0; i--) {
    const [rx, ry, rw, rh] = boxOf(here[i].rect ?? [0, 0, 1, 1])
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return here[i]
  }
  return null
}

// The slots a clip can be dropped into: the active layout's cells, or the whole
// frame when no grid is on.
const slots = () => (state.grid ? LAYOUTS[state.grid] : [[0, 0, 1, 1]])

const slotAt = (e) => {
  const r = canvas.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
  const list = slots()
  // Search backwards so a small overlay slot wins over the background it sits on.
  for (let i = list.length - 1; i >= 0; i--) {
    const [rx, ry, rw, rh] = boxOf(list[i])
    if (x >= rx && x < rx + rw && y >= ry && y < ry + rh) return i
  }
  return -1
}

const MINR = 0.05

// Which grip is under the pointer, if any. Tolerance is in screen pixels so it
// stays grabbable regardless of output resolution.
// Where a rect actually lands on screen once the gap has inset it, in 0..1.
function boxOf(rect) {
  const [bx, by, bw, bh] = R.panelBox(state, rect)
  return [bx / state.out.w, by / state.out.h, bw / state.out.w, bh / state.out.h]
}

function handleAt(e, rect) {
  const r = canvas.getBoundingClientRect()
  const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
  const [rx, ry, rw, rh] = boxOf(rect)
  const tolX = 13 / r.width, tolY = 13 / r.height
  for (const [id, hx, hy] of R.HANDLES) {
    if (Math.abs(x - (rx + hx * rw)) <= tolX && Math.abs(y - (ry + hy * rh)) <= tolY) return id
  }
  return null
}

// Resize from one grip, keeping the panel inside the frame and above a minimum.
function resized([x, y, w, h], id, dx, dy) {
  if (id.includes('w')) { const nx = clamp(x + dx, 0, x + w - MINR); w += x - nx; x = nx }
  if (id.includes('e')) { w = clamp(w + dx, MINR, 1 - x) }
  if (id.includes('n')) { const ny = clamp(y + dy, 0, y + h - MINR); h += y - ny; y = ny }
  if (id.includes('s')) { h = clamp(h + dy, MINR, 1 - y) }
  return [x, y, w, h]
}

let drag = null
canvas.onpointerdown = (e) => {
  // Frame mode: grips resize the selected panel, the body moves it.
  if (mode === 'frame') {
    const clip = curClip()
    if (!clip) return
    const rect0 = clip.rect ?? [0, 0, 1, 1]
    const grip = handleAt(e, rect0)
    const inside = (() => {
      const r = canvas.getBoundingClientRect()
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height
      const [bx, by, bw, bh] = boxOf(rect0)
      return x >= bx && x <= bx + bw && y >= by && y <= by + bh
    })()
    if (!grip && !inside) return
    e.preventDefault()
    snapshot()
    const x0 = e.clientX, y0 = e.clientY
    const r = canvas.getBoundingClientRect()
    // No pointer capture needed: the listeners live on window, which sees
    // everything anyway, and capture throws on a stale pointer id.

    const move = (ev) => {
      const dx = (ev.clientX - x0) / r.width, dy = (ev.clientY - y0) / r.height
      clip.rect = grip
        ? resized(rect0, grip, dx, dy)
        : [clamp(rect0[0] + dx, 0, 1 - rect0[2]), clamp(rect0[1] + dy, 0, 1 - rect0[3]), rect0[2], rect0[3]]
    }
    const up = () => {
      removeEventListener('pointermove', move)
      removeEventListener('pointerup', up)
      ui(); persist()
    }
    addEventListener('pointermove', move)
    addEventListener('pointerup', up)
    return
  }

  const clip = clipAt(e)
  if (!clip) return
  if (state.sel !== clip.id) { state.sel = clip.id; ui() }
  const [, , rw, rh] = clip.rect ?? [0, 0, 1, 1]
  const r = canvas.getBoundingClientRect()
  drag = {
    x: e.clientX, y: e.clientY, w: rw * r.width, h: rh * r.height, clip,
    from: slotAt(e), panning: true,
    // kept so a drag that turns into a rearrange can undo the panning it did
    crop: { zoom: clip.zoom, panX: clip.panX, panY: clip.panY },
  }
  try { canvas.setPointerCapture(e.pointerId) } catch {}
}

canvas.onpointermove = (e) => {
  if (!drag || mode === 'frame') return
  const over = slotAt(e)

  // Left the slot we started in: this is a rearrange, not a crop pan.
  if (over >= 0 && over !== drag.from) {
    if (drag.panning) Object.assign(drag.clip, drag.crop) // put the crop back
    drag.panning = false
    hoverRect = slots()[over]
    dropSlot = over
    return
  }

  hoverRect = null
  dropSlot = -1
  if (!drag.panning) { // came back home — resume panning from here
    drag.panning = true
    drag.x = e.clientX; drag.y = e.clientY
    return
  }
  // Lower pan reveals more of the left/top, so dragging right lowers panX.
  drag.clip.panX = clamp(drag.clip.panX - (2 * (e.clientX - drag.x)) / drag.w, -1, 1)
  drag.clip.panY = clamp(drag.clip.panY - (2 * (e.clientY - drag.y)) / drag.h, -1, 1)
  drag.x = e.clientX; drag.y = e.clientY
}

canvas.onpointerup = () => {
  if (drag && dropSlot >= 0 && dropSlot !== drag.from) {
    const target = slots()[dropSlot]
    const moved = drag.clip
    // Swap with whoever holds that slot; if nobody does, just move in.
    const sitting = R.clipsAt(state, t).find((c) => c.id !== moved.id && rectEq(c.rect, target))
    mutate(() => {
      const a = state.clips.find((c) => c.id === moved.id)
      const b = sitting && state.clips.find((c) => c.id === sitting.id)
      if (b) b.rect = a.rect ? [...a.rect] : null
      if (a) a.rect = [...target]
    })
  } else if (drag) {
    persist() // a crop pan doesn't go through mutate()
  }
  drag = null
  hoverRect = null
  dropSlot = -1
}
canvas.onpointercancel = () => { drag = null; hoverRect = null; dropSlot = -1 }
canvas.onwheel = (e) => {
  const clip = curClip()
  if (!clip) return
  e.preventDefault()
  clip.zoom = clamp(clip.zoom * (1 - e.deltaY / 500), 1, 5)
  if (tab === 'adjust') drawPanel() // not mid-drag, so a rebuild is fine here
  persist()
}

// drop a clip onto the preview to place it at the playhead
canvas.ondragover = (e) => { if (hasSrc(e)) { e.preventDefault(); canvas.classList.add('drop') } }
canvas.ondragleave = () => canvas.classList.remove('drop')
canvas.ondrop = (e) => {
  canvas.classList.remove('drop')
  const srcId = e.dataTransfer.getData(SRC_MIME)
  if (!srcId) return
  e.preventDefault()
  addClip(srcId, rowCount(), t)
}

// drop video files anywhere in the window to import them
let dragDepth = 0
addEventListener('dragenter', (e) => {
  if (!hasFiles(e)) return
  dragDepth++
  document.body.classList.add('filedrop')
})
addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('filedrop') } })
addEventListener('dragover', (e) => { if (hasFiles(e) || hasSrc(e)) e.preventDefault() })
addEventListener('drop', (e) => {
  dragDepth = 0
  document.body.classList.remove('filedrop')
  const files = [...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('video/'))
  if (!files.length) return
  e.preventDefault()
  tab = 'media'
  addFiles(files)
})

addEventListener('keydown', (e) => {
  if (e.target?.matches?.('input,select,textarea')) return // target isn't always an Element
  if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play() }
  // Backspace would otherwise navigate the page away.
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteClip() }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
    e.preventDefault()
    e.shiftKey ? doRedo() : doUndo()
  }
})

// ---- export dialog ------------------------------------------------------
// One modal carries the whole job: settings -> progress -> preview + download.

const CRF_LABEL = (v) =>
  v <= 20 ? 'Best — largest file' : v <= 23 ? 'Good — balanced' : v <= 28 ? 'Okay — small' : 'Rough — smallest'

// Marks the button whose value matches, in a segmented control.
function segment(id, value, onPick) {
  for (const b of $(id).querySelectorAll('button')) {
    b.classList.toggle('on', b.value === value)
    b.onclick = () => onPick(b.value)
  }
}

const pane = (which) => {
  for (const id of ['xset', 'xwork', 'xdone']) $(`#${id}`).hidden = id !== which
}

function progress(frac, title, stage) {
  if (title) $('#xtitle').textContent = title
  if (stage) $('#xstage').textContent = stage
  const bar = $('#xbar').parentElement
  bar.classList.toggle('busy', frac == null)          // null = indeterminate
  $('#xbar').style.width = frac == null ? '' : `${Math.round(clamp(frac, 0, 1) * 100)}%`
}

function drawDialog() {
  const x = state.xp
  $('#xname').value = x.name
  $('#xcrf').value = x.crf
  $('#xmb').value = x.mb
  $('#xcrflab').textContent = `Quality — CRF ${x.crf} · ${CRF_LABEL(x.crf)}`
  $('#xqual').hidden = x.mode !== 'quality'
  $('#xsize').hidden = x.mode !== 'size'
  segment('#xmode', x.mode, (v) => { x.mode = v; drawDialog() })
  segment('#xcodec', x.codec, (v) => { x.codec = v; drawDialog() })
  segment('#xspeed', x.speed, (v) => { x.speed = v; drawDialog() })
  $('#xnote').textContent =
    `${state.out.w}×${state.out.h} · ${fmt(R.totalDur(state))} · records in realtime, so keep this tab visible.`
  paintRanges()
}

$('#xname').oninput = () => { state.xp.name = $('#xname').value }
$('#xcrf').oninput = () => {
  state.xp.crf = +$('#xcrf').value
  $('#xcrflab').textContent = `Quality — CRF ${state.xp.crf} · ${CRF_LABEL(state.xp.crf)}`
}
$('#xmb').oninput = () => { state.xp.mb = +$('#xmb').value }
$('#xcancel').onclick = () => $('#xdlg').close()
$('#xclose').innerHTML = icon('x', 17)
$('#xclose').onclick = () => { if (!busy) $('#xdlg').close() }
$('#xagain').onclick = () => { pane('xset'); drawDialog() }

// Escape must not walk away from a recording that's still running.
$('#xdlg').addEventListener('cancel', (e) => { if (busy) e.preventDefault() })

// Release the previous result before showing a new one.
let resultUrl = null
const dropResult = () => {
  if (resultUrl) URL.revokeObjectURL(resultUrl)
  resultUrl = null
  $('#xvid').removeAttribute('src')
}

$('#go').onclick = () => {
  if (busy) return
  if (!R.totalDur(state)) return setStatus('nothing on the timeline', true)
  dropResult()
  // Follow the project name, unless the filename was set by hand for this project.
  const auto = slug(state.title) || 'edit'
  if (!state.xp.name || state.xp.name === state.xp.auto) state.xp.name = auto
  state.xp.auto = auto
  pane('xset')
  drawDialog()
  $('#xdlg').showModal()
}

$('#xgo').onclick = async () => {
  if (busy) return
  persist()
  const x = state.xp
  const file = `${(x.name || 'edit').replace(/[^\w.-]+/g, '_').replace(/\.mp4$/i, '')}.mp4`

  busy = true
  $('#go').disabled = true
  pane('xwork')
  progress(0, 'Recording', 'starting…')
  pause()

  try {
    // Prime everything BEFORE handing control to exportVideo: it starts the
    // recorder, and anything slow after that is captured as a frozen frame.
    await seek(0)
    await R.resume()
    // Record at the real output size, not the preview's reduced one.
    R.setScale(1)
    canvas.width = state.out.w
    canvas.height = state.out.h

    const { url, raw } = await R.exportVideo(canvas, state, async (dur) => {
      t = 0
      playing = true
      $('#play').innerHTML = icon('pause', 16)
      await new Promise((done) => {
        const iv = setInterval(() => {
          progress(t / dur, 'Recording', `${t.toFixed(1)}s of ${dur.toFixed(1)}s`)
          if (!playing) { clearInterval(iv); done() }
        }, 50) // tight, so the tail overshoot stays under a frame
      })
    }, (msg) => progress(null, 'Compressing', msg), {
      name: file, mode: x.mode, crf: String(x.crf), mb: String(x.mb),
      codec: x.codec, speed: x.speed,
    })

    // Pull the result down so the preview plays and the filename sticks on save
    // (a cross-origin href ignores the download attribute).
    progress(null, 'Fetching result', 'downloading the finished file…')
    const out = await fetch(url).then((r) => r.blob())
    resultUrl = URL.createObjectURL(out)

    $('#xvid').src = resultUrl
    $('#xdl').href = resultUrl
    $('#xdl').download = file
    $('#xdl').textContent = `Download ${file}`
    $('#xstats').textContent =
      `${file} · ${(out.size / 1e6).toFixed(1)}MB, from ${(raw.size / 1e6).toFixed(1)}MB recorded ` +
      `(${Math.round((1 - out.size / raw.size) * 100)}% smaller) · ${state.out.w}×${state.out.h}`
    pane('xdone')
    setStatus(`exported ${file}`)
  } catch (e) {
    pane('xset')
    drawDialog()
    setStatus(String(e.message || e), true)
    $('#xnote').textContent = `Export failed: ${e.message || e}`
  } finally {
    busy = false
    $('#go').disabled = false
    ui() // restore the preview-sized canvas
  }
}

// Boot: lift any old single-project store, then open the last project — or make
// the first one. Runs before first paint so a refresh is a no-op.
;(async () => {
  try {
    await store.migrate(Date.now())
    projects = await store.listProjects()
    const cur = (await store.currentId()) ?? projects[0]?.id
    const saved = cur ? await store.loadProject(cur) : null

    if (saved) {
      state = { ...BLANK(), ...saved, xp: { ...BLANK().xp, ...(saved.xp ?? {}) } }
      normalize() // an older project may predate the one-sequence-per-row rule
      await loadBackdrop()
      setStatus(saved.lost
        ? `restored — ${saved.lost} clip(s) couldn't be recovered`
        : `restored ${state.sources.length} clip(s)`, !!saved.lost)
    } else {
      state.id = await store.newProject(state.title, Date.now())
      projects = await store.listProjects()
    }
  } catch (e) {
    setStatus(`couldn't open the last project: ${e.message || e}`, true)
    if (!state.id) state.id = await store.newProject(state.title, Date.now()).catch(() => null)
  }
  ui()
  requestAnimationFrame(loop)
})()

window.editz = { get state() { return state }, R }
