// Project persistence.
//
// Video can't live in localStorage (~5MB, strings only), and blob: URLs are dead
// after unload — so the File objects themselves go into IndexedDB and get fresh
// object URLs on boot. The state doc is small JSON stored alongside them.

const DBN = 'editz'
const STORE = 'kv'
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
const DOC = 'doc'
// Bumped when the doc shape changes; older docs are dropped rather than guessed at.
const SCHEMA = 2

// Written once when a clip is imported, not on every save — blobs are big.
export const rememberFile = (id, file) => put(FILE(id), file)

// Saves are debounced: mutate() fires often and the doc rewrite is pointless churn.
let timer, pending
export function save(state, onError) {
  pending = state
  clearTimeout(timer)
  timer = setTimeout(async () => {
    try {
      await put(DOC, {
        v: SCHEMA,
        title: pending.title,
        clips: pending.clips,
        grid: pending.grid,
        gap: pending.gap,
        pad: pending.pad,
        bg: pending.bg,
        out: pending.out,
        sel: pending.sel,
        // url is a dead blob: handle after reload, so it is not persisted
        sources: pending.sources.map(({ url, ...rest }) => rest),
      })
    } catch (e) {
      onError?.(e)
    }
  }, 400)
}

// Returns a state patch, or null when there's nothing saved. Sources whose blob
// went missing are dropped, and any cell pointing at one is emptied, so a partial
// store can't resurrect a timeline full of broken references.
export async function loadProject() {
  let doc
  try {
    doc = await get(DOC)
  } catch {
    return null
  }
  if (!doc) return null
  // Pre-v2 docs stored rigid segments, which no longer have a meaning here.
  if (doc.v !== SCHEMA) { await clearProject().catch(() => {}); return null }
  if (!doc.sources?.length && !doc.clips?.length) return null

  const sources = []
  const lost = new Set()
  for (const src of doc.sources ?? []) {
    const file = await get(FILE(src.id)).catch(() => null)
    if (!file) { lost.add(src.id); continue }
    sources.push({ ...src, url: URL.createObjectURL(file) })
  }

  // A clip whose file vanished can't be shown, so it goes.
  const clips = (doc.clips ?? []).filter((c) => !lost.has(c.srcId))

  // Drop blobs no longer referenced by the doc.
  try {
    const live = new Set(sources.map((s) => FILE(s.id)))
    for (const k of await keys()) {
      if (typeof k === 'string' && k.startsWith('f:') && !live.has(k)) await del(k)
    }
  } catch {}

  return { sources, clips, title: doc.title, out: doc.out, sel: doc.sel, grid: doc.grid ?? null, gap: doc.gap ?? 0, pad: doc.pad ?? 0, bg: doc.bg ?? '#000000', lost: lost.size }
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
