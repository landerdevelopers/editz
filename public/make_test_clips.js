// Dev fixture: synthesise labelled test clips and push them through the real
// import path, so the editor can be exercised without hunting for sample footage.
// Console:  import('/make_test_clips.js').then(m => m.makeTestClips())
//
// Uses setInterval rather than requestAnimationFrame so it still runs in a
// backgrounded tab (rAF freezes when the page is hidden).

const clip = (label, color, hz, secs, w, h) => new Promise((resolve) => {
  const cv = Object.assign(document.createElement('canvas'), { width: w, height: h })
  const c = cv.getContext('2d')
  const ac = new AudioContext()
  const dest = ac.createMediaStreamDestination()
  const osc = ac.createOscillator()
  const g = ac.createGain()
  osc.frequency.value = hz
  g.gain.value = 0.05
  osc.connect(g); g.connect(dest); osc.start()

  const stream = cv.captureStream(30)
  for (const t of dest.stream.getAudioTracks()) stream.addTrack(t)

  const chunks = []
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm', videoBitsPerSecond: 4e6 })
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data)
  rec.onstop = () => {
    try { osc.stop(); ac.close() } catch {}
    resolve(new File(chunks, `${label}.webm`, { type: 'video/webm' }))
  }

  const t0 = performance.now()
  const iv = setInterval(() => {
    const el = (performance.now() - t0) / 1000
    c.fillStyle = color
    c.fillRect(0, 0, w, h)
    c.fillStyle = '#fff'
    // Moving ball proves frames advance; corner squares make cropping visible.
    c.beginPath(); c.arc(w * (0.15 + 0.7 * Math.min(1, el / secs)), h * 0.62, h * 0.13, 0, 7); c.fill()
    c.fillRect(0, 0, 44, 44); c.fillRect(w - 44, h - 44, 44, 44)
    c.textAlign = 'center'
    c.font = `bold ${Math.round(h / 7)}px system-ui`
    c.fillText(label, w / 2, h * 0.25)
    c.font = `${Math.round(h / 12)}px system-ui`
    c.fillText(`${el.toFixed(1)}s`, w / 2, h * 0.38)
    if (el >= secs) { clearInterval(iv); rec.stop() }
  }, 40)
  rec.start(200)
})

export async function makeTestClips() {
  const files = await Promise.all([
    clip('RED', '#c0392b', 440, 5, 640, 360),   // 16:9
    clip('BLUE', '#2471a3', 554, 5, 640, 360),  // 16:9
    clip('GREEN', '#1e8449', 659, 4, 360, 640), // 9:16, exercises cover-fit
    clip('GOLD', '#b7950b', 784, 4, 480, 480),  // 1:1
  ])
  const dt = new DataTransfer()
  for (const f of files) dt.items.add(f)
  const input = document.getElementById('file')
  input.files = dt.files
  input.dispatchEvent(new Event('change'))
  return files.map((f) => `${f.name} ${(f.size / 1024).toFixed(0)}KB`)
}
