// Local dev server: static files + the same two endpoints the deployed function
// serves, backed by the same module, so local is a faithful rehearsal of prod.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, normalize, join } from 'node:path'
import { createJob, jobStatus } from './freeconvert.js'

try { process.loadEnvFile('.env') } catch {} // optional; env vars work too

const KEY = process.env.FREECONVERT_API_KEY
const PORT = process.env.PORT || 8080
const ROOT = import.meta.dirname

const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.json': 'application/json', '.ico': 'image/x-icon',
}

createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const json = (code, obj) =>
    res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(obj))

  if (url.pathname === '/api/job') {
    if (!KEY) return json(500, { error: 'FREECONVERT_API_KEY is not set' })
    try {
      if (req.method === 'POST') {
        const job = await createJob(KEY, url.searchParams)
        console.log('job', job.id, '->', job.name)
        return json(200, job)
      }
      if (req.method === 'GET') {
        const id = url.searchParams.get('id')
        if (!id) return json(400, { error: 'missing id' })
        return json(200, await jobStatus(KEY, id))
      }
      return json(405, { error: 'method not allowed' })
    } catch (e) {
      console.error(e)
      return json(502, { error: String(e.message || e) })
    }
  }

  // Static, confined to ROOT.
  const rel = normalize(url.pathname).replace(/^(\.\.[/\\])+/, '')
  const file = join(ROOT, rel === '/' ? 'index.html' : rel)
  if (!file.startsWith(ROOT)) return res.writeHead(403).end('forbidden')
  try {
    const data = await readFile(file)
    res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(data)
  } catch {
    res.writeHead(404).end('not found')
  }
}).listen(PORT, () => {
  console.log(`editz  ->  http://localhost:${PORT}`)
  if (!KEY) console.log('note: FREECONVERT_API_KEY unset — editing works, export will 500')
})
