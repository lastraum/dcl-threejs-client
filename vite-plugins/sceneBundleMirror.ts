import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'

const API_PREFIX = '/api/mirror-scene-bundle'
const OUT_ROOT = path.resolve(process.cwd(), 'dev/scene-bundles')

type MirrorBody = {
  entityId?: string
  commsPointer?: string
  title?: string
  hash?: string
  scriptUrl?: string
  code?: string
  patched?: string
  mirroredAt?: string
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 120) || 'unknown'
}

function sendJson(res: Connect.ServerResponse, status: number, body: unknown): void {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

function readBody(req: Connect.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function sceneBundleMirrorPlugin(): Plugin {
  return {
    name: 'scene-bundle-mirror',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(API_PREFIX)) {
          next()
          return
        }

        if (req.method !== 'POST') {
          sendJson(res, 405, { error: 'POST only' })
          return
        }

        try {
          const raw = await readBody(req)
          const body = JSON.parse(raw) as MirrorBody
          const code = body.code
          if (!code || typeof code !== 'string') {
            sendJson(res, 400, { error: 'Missing code' })
            return
          }

          const sceneKey = sanitizeSegment(body.commsPointer || body.entityId || 'scene')
          const hashKey = sanitizeSegment((body.hash || 'unknown').slice(0, 16))
          const dir = path.join(OUT_ROOT, sceneKey, hashKey)
          await fsp.mkdir(dir, { recursive: true })

          await Promise.all([
            fsp.writeFile(path.join(dir, 'index.js'), code, 'utf8'),
            body.patched
              ? fsp.writeFile(path.join(dir, 'index.patched.js'), body.patched, 'utf8')
              : Promise.resolve(),
            fsp.writeFile(
              path.join(dir, 'meta.json'),
              JSON.stringify(
                {
                  entityId: body.entityId,
                  commsPointer: body.commsPointer,
                  title: body.title,
                  hash: body.hash,
                  scriptUrl: body.scriptUrl,
                  bytes: code.length,
                  patchedBytes: body.patched?.length ?? 0,
                  mirroredAt: body.mirroredAt ?? new Date().toISOString()
                },
                null,
                2
              ),
              'utf8'
            )
          ])

          sendJson(res, 200, { ok: true, dir: path.relative(process.cwd(), dir) })
        } catch (e) {
          sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    }
  }
}