// Vercel serverless endpoint. POST mints a job, GET reports its status.
// The recorded video never passes through here — the browser sends it straight to
// FreeConvert using the upload form this returns, which keeps the API key server
// side without running a video-sized request through a function.
import { createJob, jobStatus } from '../freeconvert.js'

export default async function handler(req, res) {
  const key = process.env.FREECONVERT_API_KEY
  if (!key) return res.status(500).json({ error: 'FREECONVERT_API_KEY is not set' })

  try {
    if (req.method === 'POST') {
      const url = new URL(req.url, 'http://x')
      return res.status(200).json(await createJob(key, url.searchParams))
    }
    if (req.method === 'GET') {
      const id = new URL(req.url, 'http://x').searchParams.get('id')
      if (!id) return res.status(400).json({ error: 'missing id' })
      return res.status(200).json(await jobStatus(key, id))
    }
    return res.status(405).json({ error: 'method not allowed' })
  } catch (e) {
    return res.status(502).json({ error: String(e.message || e) })
  }
}
