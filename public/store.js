// Project persistence — several projects, all local, no database.
//
// Video can't live in localStorage (~5MB, strings only) and blob: URLs are dead
// after unload, so the File objects go into IndexedDB and get fresh object URLs
// on load. Each project is a small JSON doc beside them.
//
// Layout:
//   index          -> [{ id, title, updated, clips, sources }]   (for the picker)
//   cur            -> id of the project to open on boot
//   doc:<id>       -> the project itself
//   f:<sourceId>   -> a File. Shared space: source ids are unique per project,
//                     but sweeping unreferenced files must consider EVERY project
//                     or deleting one would take another's footage with it.

const DBN = 'editz'
const STORE = 'kv'
const SCHEMA = 3
let dbp

const db = () =>
  (dbp ??= new Promise((res, rej) => {
    const r = indexedDB.open(DBN, 1)
    r.onupgradeneeded = () => r.result.createObjectStore(STORE)
    r.onsuccess = () => res(r.result)
    r.onerror = () => rej(r.error)
  }))

const tx = async (mode, fn) => {
  const d = await db()
  return new Promise((res, rej) => {
    const rq = fn(d.transaction(STORE, mode).objectStore(STORE))
    rq.onsuccess = () => res(rq.result)
    rq.onerror = () => rej(rq.error)
  })
}
const get = (k) => tx('readonly', (s) => s.get(k))
const put = (k, v) => tx('readwrite', (s) => s.put(v, k))
const del = (k) => tx('readwrite', (s) => s.delete(k))
const keys = () => tx('readonly', (s) => s.getAllKeys())

const FILE = (id) => `f:${id}`
const DOC = (id) => `doc:${id}`
const uid = () => Math.random().toString(36).slice(2, 9)

// ---- files ---------------------------------------------------------------

// Written once when a clip is imported, not on every save — blobs are big.
export const rememberFile = (id, file) => put(FILE(id), file)
export const forgetFile = (id) => del(FILE(id))
export const readFile = (id) => get(FILE(id))

// ---- index ---------------------------------------------------------------

export const listProjects = async () => (await get('index').catch(() => null)) ?? []

const writeIndex = (list) =>
  put('index', [...list].sort((a, b) => (b.updated || 0) - (a.updated || 0)))

async function touchIndex(state, at) {
  const list = (await listProjects()).filter((p) => p.id !== state.id)
  list.push({
    id: state.id,
    title: state.title || 'Untitled project',
    updated: at,
    clips: state.clips.length,
    sources: state.sources.length,
  })
  await writeIndex(list)
}

export const currentId = () => get('cur').catch(() => null)
export const setCurrent = (id) => put('cur', id)

// ---- save ----------------------------------------------------------------

// Debounced: mutate() fires often and rewriting the doc every time is churn.
let timer, pending

export function save(state, onError) {
  pending = state
  clearTimeout(timer)
  timer = setTimeout(async () => {
    try {
      const at = Date.now()
      await put(DOC(pending.id), {
        v: SCHEMA,
        id: pending.id,
        title: pending.title,
        updated: at,
        clips: pending.clips,
        grid: pending.grid,
        gap: pending.gap,
        pad: pending.pad,
        bg: pending.bg,
        bgImg: pending.bgImg,
        radius: pending.radius,
        out: pending.out,
        sel: pending.sel,
        xp: pending.xp,
        // url is a dead blob: handle after reload, so it is not persisted
        sources: pending.sources.map(({ url, ...rest }) => rest),
      })
      await setCurrent(pending.id)
      await touchIndex(pending, at)
    } catch (e) {
      onError?.(e)
    }
  }, 400)
}

// Write now instead of waiting out the debounce. Needed before gc(), which reads
// the stored docs — sweeping against a stale doc would keep or drop the wrong files.
export async function flush(state) {
  clearTimeout(timer)
  const at = Date.now()
  const src = state ?? pending
  if (!src) return
  pending = src
  await put(DOC(src.id), {
    v: SCHEMA, id: src.id, title: src.title, updated: at,
    clips: src.clips, grid: src.grid, gap: src.gap, pad: src.pad,
    radius: src.radius, bg: src.bg, bgImg: src.bgImg,
    out: src.out, sel: src.sel, xp: src.xp,
    sources: src.sources.map(({ url, ...rest }) => rest),
  })
  await setCurrent(src.id)
  await touchIndex(src, at)
}

// ---- load ----------------------------------------------------------------

// Returns a state patch, or null when there's nothing saved. A source whose file
// went missing is dropped and its clips with it, so a partial store can't restore
// a timeline pointing at footage that isn't there.
export async function loadProject(id) {
  let doc
  try {
    doc = await get(DOC(id ?? (await currentId())))
  } catch {
    return null
  }
  if (!doc || doc.v !== SCHEMA) return null

  const sources = []
  const lost = new Set()
  for (const src of doc.sources ?? []) {
    const file = await get(FILE(src.id)).catch(() => null)
    if (!file) { lost.add(src.id); continue }
    sources.push({ ...src, url: URL.createObjectURL(file) })
  }
  const clips = (doc.clips ?? []).filter((c) => !lost.has(c.srcId))

  return {
    id: doc.id, title: doc.title, sources, clips,
    grid: doc.grid ?? null, gap: doc.gap ?? 0, pad: doc.pad ?? 0,
    bg: doc.bg ?? '#000000', bgImg: doc.bgImg ?? null, radius: doc.radius ?? 0,
    out: doc.out, sel: doc.sel, xp: doc.xp,
    lost: lost.size,
  }
}

export async function newProject(title, at) {
  const id = uid()
  await put(DOC(id), { v: SCHEMA, id, title, updated: at, clips: [], sources: [] })
  await setCurrent(id)
  return id
}

// A copy costs no video storage: both projects point at the same file keys, and
// gc() only deletes a file once no project references it.
export async function duplicateProject(id, title, at) {
  const doc = await get(DOC(id))
  if (!doc) throw new Error('project not found')
  const copy = { ...doc, id: uid(), title, updated: at }
  await put(DOC(copy.id), copy)
  await touchIndex({ id: copy.id, title, clips: copy.clips ?? [], sources: copy.sources ?? [] }, at)
  return copy.id
}

// Delete a project, then sweep files no project references any more.
export async function deleteProject(id) {
  await del(DOC(id))
  await writeIndex((await listProjects()).filter((p) => p.id !== id))
  await gc()
  const list = await listProjects()
  await setCurrent(list[0]?.id ?? null)
  return list
}

// Sweep orphaned files. Deliberately unions EVERY project's sources: scoping this
// to one project would delete footage the others still need.
export async function gc() {
  try {
    const live = new Set()
    for (const p of await listProjects()) {
      const doc = await get(DOC(p.id)).catch(() => null)
      for (const s of doc?.sources ?? []) live.add(FILE(s.id))
      if (doc?.bgImg) live.add(FILE(doc.bgImg)) // backdrops are files too
    }
    for (const k of await keys()) {
      if (typeof k === 'string' && k.startsWith('f:') && !live.has(k)) await del(k)
    }
  } catch {}
}

// One-time lift of the single-project v2 store into the multi-project layout.
export async function migrate(at) {
  const old = await get('doc').catch(() => null)
  if (!old || old.v !== 2) return false
  const id = uid()
  await put(DOC(id), { ...old, v: SCHEMA, id, title: old.title || 'Untitled project', updated: at })
  await writeIndex([{ id, title: old.title || 'Untitled project', updated: at,
                      clips: (old.clips ?? []).length, sources: (old.sources ?? []).length }])
  await setCurrent(id)
  await del('doc')
  return true
}

export async function clearProject() {
  clearTimeout(timer)
  const d = await db()
  return new Promise((res, rej) => {
    const rq = d.transaction(STORE, 'readwrite').objectStore(STORE).clear()
    rq.onsuccess = () => res()
    rq.onerror = () => rej(rq.error)
  })
}

export async function usage() {
  try {
    const { usage: used = 0, quota = 0 } = await navigator.storage.estimate()
    return { used, quota }
  } catch {
    return null
  }
}
