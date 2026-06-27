const BRIDGE_BASE = '/api/local-projects'

export type DevBridgeHealth = {
  ok: boolean
  configPath: string | null
  projectCount: number
}

export type DevBridgeProject = {
  id: string
  name: string
  folderName: string
  absolutePath: string
  baseParcel?: string
  parcelCount?: number
  hasSceneJson: boolean
}

export async function fetchDevBridgeHealth(): Promise<DevBridgeHealth | null> {
  try {
    const res = await fetch(`${BRIDGE_BASE}/health`)
    if (!res.ok) return null
    return (await res.json()) as DevBridgeHealth
  } catch {
    return null
  }
}

export type DevBridgeImportResult = {
  ok: boolean
  configPath: string | null
  projects: DevBridgeProject[]
  projectCount: number
  error?: string
}

/** Server-side Creator Hub scan (Vite dev only — reads config.json from disk). */
export async function importCreatorHubViaDevBridge(): Promise<DevBridgeImportResult | null> {
  try {
    const res = await fetch(`${BRIDGE_BASE}/import-creator-hub`, { method: 'POST' })
    if (res.status === 404) {
      const body = (await res.json().catch(() => null)) as { error?: string; configPath?: string } | null
      return {
        ok: false,
        configPath: body?.configPath ?? null,
        projects: [],
        projectCount: 0,
        error: body?.error ?? 'Creator Hub config not found'
      }
    }
    if (!res.ok) return null
    return (await res.json()) as DevBridgeImportResult
  } catch {
    return null
  }
}

export async function fetchDevBridgeProjects(): Promise<DevBridgeProject[]> {
  try {
    const res = await fetch(`${BRIDGE_BASE}/projects`)
    if (!res.ok) return []
    const json = (await res.json()) as { projects?: DevBridgeProject[] }
    return json.projects ?? []
  } catch {
    return []
  }
}

export async function readDevBridgeFile(rootPath: string, relativePath: string): Promise<Uint8Array | null> {
  try {
    const params = new URLSearchParams({ root: rootPath, file: relativePath })
    const res = await fetch(`${BRIDGE_BASE}/read?${params}`)
    if (!res.ok) return null
    return new Uint8Array(await res.arrayBuffer())
  } catch {
    return null
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export async function writeDevBridgeFile(
  rootPath: string,
  relativePath: string,
  bytes: Uint8Array
): Promise<void> {
  const data = bytesToBase64(bytes)
  const res = await fetch(`${BRIDGE_BASE}/write`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ root: rootPath, relativePath, data })
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null
    throw new Error(err?.error ?? `Dev bridge write failed (${res.status})`)
  }
}

export async function walkDevBridgeFiles(rootPath: string): Promise<string[]> {
  try {
    const params = new URLSearchParams({ root: rootPath })
    const res = await fetch(`${BRIDGE_BASE}/walk?${params}`)
    if (!res.ok) return []
    const json = (await res.json()) as { files?: string[] }
    return json.files ?? []
  } catch {
    return []
  }
}