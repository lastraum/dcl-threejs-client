#!/usr/bin/env node
/**
 * Sidecar log sink for iPhone → Mac (no clipboard).
 * Listens on 0.0.0.0:5174 so Tailscale can POST while Vite is on 5173.
 */
import { createServer } from 'node:http'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.env.PHONE_LOG_PORT || 5174)
const FILE = resolve(fileURLToPath(new URL('../data/phone-logs.jsonl', import.meta.url)))

mkdirSync(dirname(FILE), { recursive: true })
writeFileSync(FILE, `# phone log sink ${new Date().toISOString()}\n`, 'utf8')

function parseLines(raw) {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed)
    if (Array.isArray(parsed.lines)) return parsed.lines.map(String).filter(Boolean)
    if (parsed.line != null) return [String(parsed.line)]
  } catch {
    /* plain text */
  }
  return trimmed
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
}

const server = createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'content-type')
  res.setHeader('Access-Control-Max-Age', '86400')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }
  const url = (req.url ?? '').split('?')[0]
  if (url !== '/__phone-logs' && url !== '/') {
    res.writeHead(404)
    res.end('not found')
    return
  }
  if (req.method !== 'POST') {
    res.writeHead(405)
    res.end('POST only')
    return
  }
  const chunks = []
  req.on('data', (c) => chunks.push(c))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    const lines = parseLines(raw)
    if (lines.length) {
      const stamp = new Date().toISOString()
      appendFileSync(FILE, lines.map((l) => `${stamp} ${l}`).join('\n') + '\n', 'utf8')
      for (const line of lines) console.log(`[phone] ${line}`)
    }
    res.writeHead(204)
    res.end()
  })
  req.on('error', () => {
    res.writeHead(500)
    res.end()
  })
})

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[phone-log-sink] http://0.0.0.0:${PORT}/__phone-logs → ${FILE}`)
})
