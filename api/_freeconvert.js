// FreeConvert calls, shared by the local dev server and the serverless function.
// Nothing here touches Node's http or Vercel's request objects, so both hosts use
// the same code path and the local server stays a faithful rehearsal of production.

const API = 'https://api.freeconvert.com/v1'

const call = (key, path, opts = {}) =>
  fetch(API + path, {
    ...opts,
    headers: {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  }).then(async (r) => {
    const body = await r.json().catch(() => ({}))
    if (!r.ok) throw new Error(`FreeConvert ${path} ${r.status}: ${JSON.stringify(body)}`)
    return body
  })

// Option names confirmed against
//   GET /v1/query/options/compress?input_format=webm&output_format=mp4
// which also confirms compress takes webm in and mp4 out directly -- no convert
// step needed. Lower CRF = better quality, bigger file.
const CODECS = new Set(['libx264', 'libx265'])
const SPEEDS = new Set(['ultrafast', 'superfast', 'veryfast', 'faster', 'fast',
                        'medium', 'slow', 'slower', 'veryslow'])
const num = (v, lo, hi, dflt) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.min(Math.max(n, lo), hi) : dflt
}

// Everything here arrives from the browser, so nothing is trusted: unknown values
// fall back to a safe default rather than reaching the API.
export function quality(q) {
  const get = (k) => (typeof q.get === 'function' ? q.get(k) : q[k])
  const codec = CODECS.has(get('codec')) ? get('codec') : 'libx264'
  const speed = SPEEDS.has(get('speed')) ? get('speed') : 'veryfast'
  if (get('mode') === 'size') {
    return {
      compress_video: 'by_size',
      video_codec_compress: codec,
      video_compress_max_filesize: num(get('mb'), 1, 10240, 25),
      video_compress_speed: speed,
    }
  }
  return {
    compress_video: 'by_video_quality',
    video_codec_compress: codec,
    [codec === 'libx265' ? 'video_compress_crf_x265' : 'video_compress_crf_x264']:
      num(get('crf'), 18, 51, 21),
    video_compress_speed: speed,
  }
}

// Strip anything that isn't a plain file name before it reaches the API.
export const safeName = (n) => {
  const base = String(n || 'edit').split(/[\\/]/).pop().replace(/[^\w.-]+/g, '_').slice(0, 80)
  return /\.mp4$/i.test(base) ? base : `${base || 'edit'}.mp4`
}

// Mint the job and hand back where to PUT the bytes. The browser uploads straight
// to FreeConvert: a serverless function can't relay a video (body caps and short
// timeouts), and proxying one would be pointless traffic even where it can.
export async function createJob(key, params) {
  const ext = (typeof params.get === 'function' ? params.get('ext') : params.ext) === 'mp4' ? 'mp4' : 'webm'
  const name = safeName(typeof params.get === 'function' ? params.get('name') : params.name)
  const job = await call(key, '/process/jobs', {
    method: 'POST',
    body: JSON.stringify({
      tag: 'editz',
      tasks: {
        'import-1': { operation: 'import/upload' },
        'compress-1': {
          operation: 'compress',
          input: 'import-1',
          input_format: ext,
          output_format: 'mp4',
          options: quality(params),
        },
        'export-1': { operation: 'export/url', input: ['compress-1'], filename: name },
      },
    }),
  })

  const form = (job.tasks || []).find((t) => t.name === 'import-1')?.result?.form
  if (!form) throw new Error(`no upload form in job response: ${JSON.stringify(job)}`)
  return { id: job.id, upload: form, name }
}

// One poll. The browser drives the loop, so no host timeout can cut a job short.
export async function jobStatus(key, id) {
  const j = await call(key, `/process/jobs/${encodeURIComponent(id)}`)
  if (j.status === 'failed') {
    const why = (j.tasks || []).map((t) => t.result?.error || t.status).join('; ')
    return { status: 'failed', error: why || 'job failed' }
  }
  if (j.status !== 'completed') return { status: j.status || 'processing' }
  const url = (j.tasks || []).find((t) => t.name === 'export-1')?.result?.url
  if (!url) return { status: 'failed', error: 'completed with no download url' }
  return { status: 'completed', url }
}
