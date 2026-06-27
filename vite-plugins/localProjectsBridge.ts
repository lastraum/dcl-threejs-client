import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { Connect, Plugin } from 'vite'

const API_PREFIX = '/api/local-projects'

type CreatorHubConfig = {
  settings?: { scenesPath?: string }
  workspace?: { paths?: string[] }
}

type BridgeProject = {
  id: string
  name: string
  folderName: string
  absolutePath: string
  baseParcel?: string
  parcelCount?: number
  hasSceneJson: boolean
}

function creatorHubConfigPath(): string {
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/creator-hub/Settings/config.json')
  }
  if (process.platform === 'win32') {
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'),
      'creator-hub',
      'Settings',
      'config.json'
    )
  }
  return path.join(os.homedir(), '.config/creator-hub/Settings/config.json')
}

function folderNameFromPath(folderPath: string): string {
  const normalized = folderPath.replace(/[/\\]+$/, '')
  return path.basename(normalized) || folderPath
}

function creatorHubProjectId(folderName: string): string {
  return `creator-hub:${folderName}`
}

function creatorHubPathProjectId(fullPath: string): string {
  let h = 0
  for (let i = 0; i < fullPath.length; i++) {
    h = (Math.imul(31, h) + fullPath.charCodeAt(i)) | 0
  }
  return `creator-hub-path:${(h >>> 0).toString(36)}`
}

async function readCreatorHubConfig(): Promise<{ config: CreatorHubConfig; configPath: string } | null> {
  const configPath = creatorHubConfigPath()
  try {
    const raw = await fsp.readFile(configPath, 'utf8')
    const parsed = JSON.parse(raw) as CreatorHubConfig
    return { config: parsed, configPath }
  } catch {
    return null
  }
}

async function projectEntriesFromConfig(config: CreatorHubConfig): Promise<
  Array<{ id: string; folderName: string; absolutePath: string; underScenesPath: boolean }>
> {
  const paths = config.workspace?.paths?.filter((p) => typeof p === 'string' && p.trim()) ?? []
  const scenesPath = config.settings?.scenesPath?.replace(/[/\\]+$/, '')
  const seen = new Set<string>()
  const out: Array<{ id: string; folderName: string; absolutePath: string; underScenesPath: boolean }> = []

  for (const rawPath of paths) {
    const absolutePath = path.resolve(rawPath)
    const folderName = folderNameFromPath(absolutePath)
    const underScenesPath = Boolean(scenesPath && absolutePath.startsWith(path.resolve(scenesPath)))
    const id = underScenesPath ? creatorHubProjectId(folderName) : creatorHubPathProjectId(absolutePath)
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ id, folderName, absolutePath, underScenesPath })
  }

  if (scenesPath) {
    const scenesRoot = path.resolve(scenesPath)
    try {
      const entries = await fsp.readdir(scenesRoot, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue
        const absolutePath = path.join(scenesRoot, entry.name)
        const folderName = entry.name
        const id = creatorHubProjectId(folderName)
        if (seen.has(id)) continue
        seen.add(id)
        out.push({ id, folderName, absolutePath, underScenesPath: true })
      }
    } catch {
      /* scenesPath missing or unreadable */
    }
  }

  return out
}

async function readSceneJsonMeta(
  absolutePath: string
): Promise<{ name: string; baseParcel?: string; parcelCount?: number; hasSceneJson: boolean }> {
  const scenePath = path.join(absolutePath, 'scene.json')
  try {
    const raw = await fsp.readFile(scenePath, 'utf8')
    const json = JSON.parse(raw) as {
      display?: { title?: string }
      scene?: { base?: string; parcels?: string[] }
    }
    return {
      name: json.display?.title?.trim() || folderNameFromPath(absolutePath),
      baseParcel: json.scene?.base,
      parcelCount: json.scene?.parcels?.length,
      hasSceneJson: true
    }
  } catch {
    return { name: folderNameFromPath(absolutePath), hasSceneJson: false }
  }
}

async function loadAllowedRoots(): Promise<Set<string>> {
  const loaded = await readCreatorHubConfig()
  if (!loaded) return new Set()
  const entries = await projectEntriesFromConfig(loaded.config)
  return new Set(entries.map((e) => e.absolutePath))
}

function isRootAllowed(allowed: Set<string>, rootPath: string): boolean {
  const resolved = path.resolve(rootPath)
  return allowed.has(resolved)
}

async function walkProjectFiles(rootPath: string, prefix = ''): Promise<string[]> {
  const out: string[] = []
  const entries = await fsp.readdir(path.join(rootPath, prefix), { withFileTypes: true })
  for (const entry of entries) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      out.push(...(await walkProjectFiles(rootPath, rel)))
    } else {
      out.push(rel)
    }
  }
  return out
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

async function listBridgeProjects(): Promise<BridgeProject[]> {
  const loaded = await readCreatorHubConfig()
  if (!loaded) return []
  const entries = await projectEntriesFromConfig(loaded.config)
  const out: BridgeProject[] = []
  for (const entry of entries) {
    const meta = await readSceneJsonMeta(entry.absolutePath)
    if (!meta.hasSceneJson) continue
    out.push({
      id: entry.id,
      name: meta.name,
      folderName: entry.folderName,
      absolutePath: entry.absolutePath,
      baseParcel: meta.baseParcel,
      parcelCount: meta.parcelCount,
      hasSceneJson: true
    })
  }
  return out
}

export function localProjectsBridgePlugin(): Plugin {
  return {
    name: 'local-projects-bridge',
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = req.url ?? ''
        if (!url.startsWith(API_PREFIX)) {
          next()
          return
        }

        try {
          const parsed = new URL(url, 'http://127.0.0.1')
          const pathname = parsed.pathname

          if (req.method === 'GET' && pathname === `${API_PREFIX}/health`) {
            const loaded = await readCreatorHubConfig()
            const projects = loaded ? await listBridgeProjects() : []
            sendJson(res, 200, {
              ok: Boolean(loaded),
              configPath: loaded?.configPath ?? null,
              projectCount: projects.length
            })
            return
          }

          if (req.method === 'GET' && pathname === `${API_PREFIX}/projects`) {
            sendJson(res, 200, { projects: await listBridgeProjects() })
            return
          }

          if (req.method === 'POST' && pathname === `${API_PREFIX}/import-creator-hub`) {
            const loaded = await readCreatorHubConfig()
            if (!loaded) {
              sendJson(res, 404, {
                error: 'Creator Hub config not found on this machine.',
                configPath: creatorHubConfigPath()
              })
              return
            }
            const projects = await listBridgeProjects()
            sendJson(res, 200, {
              ok: true,
              configPath: loaded.configPath,
              projects,
              projectCount: projects.length
            })
            return
          }

          const allowed = await loadAllowedRoots()

          if (req.method === 'GET' && pathname === `${API_PREFIX}/walk`) {
            const root = parsed.searchParams.get('root')
            if (!root || !isRootAllowed(allowed, root)) {
              sendJson(res, 403, { error: 'Project path not allowed' })
              return
            }
            const files = await walkProjectFiles(path.resolve(root))
            sendJson(res, 200, { files })
            return
          }

          if (req.method === 'GET' && pathname === `${API_PREFIX}/read`) {
            const root = parsed.searchParams.get('root')
            const file = parsed.searchParams.get('file')
            if (!root || !file || !isRootAllowed(allowed, root)) {
              sendJson(res, 403, { error: 'Project path not allowed' })
              return
            }
            const abs = path.resolve(root, file)
            if (!abs.startsWith(path.resolve(root) + path.sep) && abs !== path.resolve(root)) {
              sendJson(res, 403, { error: 'Invalid file path' })
              return
            }
            try {
              const data = await fsp.readFile(abs)
              res.statusCode = 200
              res.setHeader('Content-Type', 'application/octet-stream')
              res.end(data)
            } catch (readErr) {
              const code = (readErr as NodeJS.ErrnoException).code
              if (code === 'ENOENT') {
                sendJson(res, 404, { error: 'File not found' })
              } else {
                throw readErr
              }
            }
            return
          }

          if (req.method === 'POST' && pathname === `${API_PREFIX}/write`) {
            const raw = await readBody(req)
            const body = JSON.parse(raw) as { root?: string; relativePath?: string; data?: string }
            const root = body.root
            const relativePath = body.relativePath
            const data = body.data
            if (!root || !relativePath || typeof data !== 'string' || !isRootAllowed(allowed, root)) {
              sendJson(res, 403, { error: 'Project path not allowed' })
              return
            }
            const abs = path.resolve(root, relativePath)
            const rootResolved = path.resolve(root)
            if (!abs.startsWith(rootResolved + path.sep)) {
              sendJson(res, 403, { error: 'Invalid file path' })
              return
            }
            await fsp.mkdir(path.dirname(abs), { recursive: true })
            await fsp.writeFile(abs, Buffer.from(data, 'base64'))
            sendJson(res, 200, { ok: true })
            return
          }

          sendJson(res, 404, { error: 'Not found' })
        } catch (e) {
          sendJson(res, 500, { error: e instanceof Error ? e.message : String(e) })
        }
      })
    }
  }
}