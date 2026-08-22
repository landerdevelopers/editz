# editz

Browser video editor. Import clips, arrange them freely across rows — overlapping
however you like — and apply a grid (2x2, 3x3, 4x4, strips, PiP) to play several
at once. Export records the canvas and sends it to FreeConvert to come back as a
compressed MP4.

## Run

```bash
cp .env.example .env    # then paste your FreeConvert key into it
node server.mjs
```

Then open http://localhost:8080. No install step, no dependencies.

## Deploy

Static files in `public/`, one serverless function in `api/` — the layout Vercel
and Netlify detect with zero config. Anything else invites the host to guess, and
a wrong guess routes every request into a function that has no business serving
the page. Deploys as-is.
Set `FREECONVERT_API_KEY` in the host's environment variables; it is the only
config, and it never reaches the browser.

The recorded video **does not pass through the server**. `POST /api/job` mints a
FreeConvert job and returns an upload form, the browser sends the blob straight to
FreeConvert, and `GET /api/job?id=` reports status. That keeps the key server-side
without running a video-sized body through a function that caps request bodies at
a few MB and times out in seconds — and the browser owning the poll loop means no
host timeout can cut a long compression short.

`server.mjs` serves the same two endpoints from the same `freeconvert.js`, so
local development exercises the deployed code path rather than an approximation.

## The one idea

**Clips float. Nothing is aligned to anything else.**

```js
clip = { id, srcId, row, start, dur, in, rect, zoom, panX, panY, gain, muted }
```

A clip owns where it sits (`row`, `start`), how long it runs (`dur`), which part
of the source it plays (`in`), and where it lands in the frame (`rect`). Two clips
on different rows can overlap by any amount, or not at all, and they need nothing
in common — not a start, not a length.

`row` is z-order: **row 1 is the top layer** and covers the rows below. A row only
exists where clips are, so emptying one removes it.

Overlap **across** rows is the whole point — that's layering. Overlap **within** a
row is not: two clips at the same z-order with both audio tracks playing is just
ambiguous, so a row holds a sequence. Dragging a clip onto a neighbour slides it
to the nearer free side rather than stacking on top, and trims stop at the
neighbour. `arrange.js` holds those rules, free of the DOM, and `test.mjs` covers
them.

A **grid layout is a preset, not a mode**: picking `2x2` hands the clips under the
playhead one rect each, top row first, and holds them all to the window where they
coexist — clips of 5s, 3s and 7s become three 3s clips, so no panel dies early.
"Full frame" clears the rects and they stack again. Adding a layout is one line in
`layouts.js`.

Crop and placement happen in a single 9-argument `drawImage`:

```js
ctx.drawImage(video, sx,sy,sw,sh,  dx,dy,dw,dh)
//                   \_ crop _/    \_ rect _/
```

## Projects

Several projects, all in this browser, no database. **Projects** in the rail is the
full manager — open, duplicate, delete, with clip and file counts. A quick switcher
also sits beside the project name.

Duplicating costs no extra storage: both projects point at the same video files,
and a file is only deleted once no project references it. Each is a small JSON doc in IndexedDB
alongside the video files.

Files live in one shared space keyed by source id. Sweeping unreferenced ones
therefore unions **every** project's sources — scoping that to the open project
would delete footage the others still need.

## Your work is kept

Clips and edits survive a refresh, a closed tab, or a restart — no re-uploading.

Videos can't go in `localStorage` (~5MB, strings only) and `blob:` URLs are dead
after unload, so `store.js` puts the actual `File` objects in **IndexedDB** and
mints fresh object URLs on boot. The state doc is small JSON stored beside them;
saves are debounced. A clip whose blob went missing is dropped and the cells
pointing at it are emptied, so a partial store can't restore a broken timeline.

No state library — state is one plain object with a single `mutate()` chokepoint,
which is all a persistence layer needs to hook.

**Output → Empty this project** clears its clips and frees their space; other
projects are untouched. Deleting a project is in the picker.

## Files

| File | What |
|---|---|
| `public/layouts.js` | Grid rect table, cover-fit crop, panel spacing (pure, no DOM) |
| `public/render.js` | Canvas compositor, audio graph, playback clock, export |
| `public/app.js` | State, undo/redo, panels, timeline |
| `public/index.html` | Markup + styles |
| `public/icons.js` | Lucide glyphs, inlined (ISC) |
| `public/store.js` | IndexedDB persistence for the project and its video blobs |
| `api/_freeconvert.js` | FreeConvert job creation, polling, option validation |
| `api/job.js` | Serverless endpoint (Vercel/Netlify) |
| `server.mjs` | Local dev server: serves `public/` + the same endpoints |
| `public/make_test_clips.js` | Dev fixture: generates labelled test clips in-browser |
| `public/arrange.js` | Row rules: one sequence per row, where a dragged clip lands |
| `test.mjs` | `node test.mjs` |

## Controls

Importing never touches the timeline — clips land in Media and you place them.

- **Drag** a clip from Media onto any row; it starts where you let go. The **+** on
  a thumbnail puts it on a new row, the **×** removes it from the project. Video
  files can be dropped anywhere in the window to import.
- **Drag a clip** along its row to move it in time, or up and down to change rows.
  Positions snap to other clips, to zero, and to the playhead; a clip never lands
  on top of another on the same row.
- **Drag a clip's ‹ › edges** to trim. The left edge moves the start and in-point
  together so the footage under the cursor stays put; the right edge stops at the
  end of the footage.
- **Split** cuts the selected clip at the playhead. **Delete** (or Del/Backspace)
  removes it. Emptying a row removes the row.
- **Grid** applies a layout to whatever is under the playhead and trims them all
  to their shared window, so none runs out early; **Full frame** clears the rects
  so those clips stack instead.
- **Crop / Frame** above the timeline switches what dragging the preview does:
  Crop pans inside a clip, Frame moves and resizes its panel by the corner grips.
  Exact X/Y/W/H live in the Adjust panel.
- **Output** sets gap, padding and corner rounding, plus the background — a colour
  or an uploaded image, cover-fitted behind the panels. Gap and padding are
  independent, so panels can be spaced apart with no border around the outside.
- **Drag a clip in the preview onto another grid slot** to move or swap it —
  empty slots included. The target slot is outlined while you drag.
- **Drag inside one slot** to pan its crop, **scroll** to zoom. A drag that leaves
  the slot becomes a rearrange instead, and the crop it nudged is put back.
- **Drag the grip** above the timeline toolbar to trade space with the preview;
  double-click it to go back to sizing itself.
- Space plays/pauses, Cmd/Ctrl+Z undoes, Cmd/Ctrl+Shift+Z redoes.

## Export

**Export** opens a settings dialog first: file name, target-quality (CRF 18–35) or
target-file-size (MB), H.264 or H.265, and encoder effort. Choices are remembered.

The page records the timeline off the canvas in realtime, then `server.mjs` posts
the blob to FreeConvert and polls for the finished MP4. The compress task takes
webm in and mp4 out directly — confirmed against
`GET /v1/query/options/compress?input_format=webm&output_format=mp4`, which is
also where the option names come from. Settings arriving from the browser are
re-validated server-side against allowlists before they reach the API.

## Performance

A `<video>` element is a live decoder, not a cheap handle, so elements exist only
for clips the playhead is near (±3s) and are released beyond a ceiling of eight.
Creating one per clip up front is unnoticeable with small test files and crippling
with 1080p screen recordings — twelve clips meant twelve simultaneous HD decoders.

The preview also composites at a capped pixel count rather than the export size:
filling 1920×1080 every frame to display it a few hundred pixels wide is wasted
work. Export resets the scale to 1.

Measured with twelve clips: decoders 15 → 4, and 0.13ms → 0.018ms per composite.

## Known ceiling

Export records in **realtime** off the canvas, so a 60s edit takes 60s and the
tab must stay visible (`requestAnimationFrame` freezes in background tabs).
Because MediaRecorder captures wall-clock, everything slow — audio resume, seeks,
decoding frame zero — happens *before* `rec.start()`; anything left after it lands
in the file as a freeze. If playback can't keep up, the status line says so. A 4x4
segment decodes 16 videos at once and will drop frames on most machines; 2x2 is
comfortable. If either becomes a problem the fix is to replace `exportVideo()` in
`render.js` with a server-side ffmpeg `filter_complex` (xstack + crop + trim),
which is frame-exact and faster than realtime. Export is deliberately a single
function so that swap stays cheap.

## Credits

Icons from [Lucide](https://lucide.dev) — ISC License, © Lucide Icons and
Contributors; icons derived from Feather are MIT, © Cole Bemis. Inlined in
`public/icons.js` rather than depended on, since the app has no build step.

## Not built

Transitions, text overlays, colour grading, keyframes, a music track, speed ramps.
