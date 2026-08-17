/**
 * Perf sample sink.
 *
 * The page cannot write to disk, and reading numbers off an overlay by eye
 * is exactly what this is meant to replace — storm foam varies faster than
 * anyone can transcribe, and the interesting question (does cost track
 * coverage?) needs the two sampled together, many times.
 *
 * So: the page POSTs newline-delimited JSON here via navigator.sendBeacon
 * and this appends it. Beacon is deliberate — it is fire-and-forget, so a
 * slow or absent sink can never show up as a frame-time artefact in the
 * very measurement it is collecting.
 *
 *   node tools/perf-logger.mjs [outfile] [port]
 */
import { createServer } from 'node:http'
import { appendFileSync, writeFileSync, existsSync } from 'node:fs'

const OUT = process.argv[2] ?? 'perf-log.jsonl'
const PORT = Number(process.argv[3] ?? 8787)

if (!existsSync(OUT)) writeFileSync(OUT, '')

let lines = 0

const server = createServer((req, res) => {
  // Beacon sends text/plain, which is a "simple" request — no preflight.
  // The permissive header is still here for a plain fetch() fallback.
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')

  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  if (req.method === 'POST') {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      if (body.trim()) {
        appendFileSync(OUT, body.endsWith('\n') ? body : body + '\n')
        lines += body.trim().split('\n').length
        process.stdout.write(`\r${lines} samples -> ${OUT}   `)
      }
      res.writeHead(204).end()
    })
    return
  }
  res.writeHead(200).end(`perf-logger: ${lines} samples -> ${OUT}\n`)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`perf-logger listening on http://127.0.0.1:${PORT} -> ${OUT}`)
})
