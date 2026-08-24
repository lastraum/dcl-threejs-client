import { appendFileSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'

export const PHONE_LOG_PATH = '/__phone-logs'
export const PHONE_LOG_FILE = path.resolve(process.cwd(), 'data/phone-logs.jsonl')

export function appendPhoneLogLines(lines: string[]): void {
  if (!lines.length) return
  mkdirSync(path.dirname(PHONE_LOG_FILE), { recursive: true })
  const stamp = new Date().toISOString()
  const block = lines.map((line) => `${stamp} ${line}`).join('\n') + '\n'
  appendFileSync(PHONE_LOG_FILE, block, 'utf8')
  for (const line of lines) {
    console.log(`[phone] ${line}`)
  }
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function parseLines(raw: string): string[] {
  const trimmed = raw.trim()
  if (!trimmed) return []
  try {
    const parsed = JSON.parse(trimmed) as { lines?: unknown; line?: unknown }
    if (Array.isArray(parsed.lines)) {
      return parsed.lines.map((l) => String(l)).filter(Boolean)
    }
    if (parsed.line != null) return [String(parsed.line)]
  } catch {
    /* plain text */
  }
  return trimmed.split('\n').map((l) => l.trim()).filter(Boolean)
}

export function phoneLogSinkPlugin(): Plugin {
  return {
    name: 'phone-log-sink',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url ?? '').split('?')[0]
        if (url !== PHONE_LOG_PATH) {
          next()
          return
        }
        res.setHeader('Access-Control-Allow-Origin', '*')
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
        res.setHeader('Access-Control-Allow-Headers', 'content-type')
        if (req.method === 'OPTIONS') {
          res.statusCode = 204
          res.end()
          return
        }
        if (req.method !== 'POST') {
          res.statusCode = 405
          res.end('POST only')
          return
        }
        try {
          const lines = parseLines(await readBody(req))
          appendPhoneLogLines(lines)
          res.statusCode = 204
          res.end()
        } catch (e) {
          res.statusCode = 500
          res.end(e instanceof Error ? e.message : 'error')
        }
      })
    }
  }
}
