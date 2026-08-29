import type { ContentFile } from '../../dcl/content/types'
import {
  CATALYST_FETCH_TIMEOUT_MS,
  fetchWithTimeout
} from '../../util/fetchWithTimeout'
import { isParcelPointer, normalizePointer } from './pointer'

import {
  entityIdFromScenesUrn,
  isOfficialWorldsServer,
  worldsAboutUrl,
  worldsContentBase
} from '../worlds/worldsServerConfig'

const WORLDS = worldsContentBase()

function parseEntityContent(raw: unknown): ContentFile[] {
  if (!Array.isArray(raw)) return []
  const out: ContentFile[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.file === 'string' && typeof r.hash === 'string') {
      out.push({ file: r.file, hash: r.hash })
    }
  }
  return out
}
const ASSET_BUNDLE_REGISTRY = 'https://asset-bundle-registry.decentraland.org'

/** Strip trailing `/content` — `/about` returns `https://peer-ec1.decentraland.org/content/`. */
export function catalystRootFromContentUrl(contentUrl: string): string {
  let base = contentUrl.replace(/\/$/, '')
  if (base.endsWith('/content')) base = base.slice(0, -'/content'.length)
  return base
}

export function catalystEntitiesActiveUrl(contentUrl: string): string {
  return `${catalystRootFromContentUrl(contentUrl)}/content/entities/active`
}

export function catalystContentAssetUrl(contentUrl: string, hash: string): string {
  return `${catalystRootFromContentUrl(contentUrl)}/content/contents/${encodeURIComponent(hash)}`
}

/** @deprecated Use POST `/content/entities/active` via `fetchSceneEntityByPointer`. */
export function catalystEntityByPointerUrl(contentUrl: string, pointer: string): string {
  return `${catalystRootFromContentUrl(contentUrl)}/content/entities/wearables/?pointer=${encodeURIComponent(normalizePointer(pointer))}`
}

/** Scene / wearable entity manifest by deployment CID (`content/contents/{entityId}`). */
export async function fetchEntityContentById(
  contentUrl: string,
  entityId: string
): Promise<ContentFile[] | null> {
  const trimmed = entityId.trim()
  if (!trimmed) return null

  const tryFetch = async (url: string): Promise<ContentFile[] | null> => {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json' },
      timeoutMs: CATALYST_FETCH_TIMEOUT_MS
    })
    if (!res.ok) return null
    const entity = (await res.json()) as { content?: unknown }
    const content = parseEntityContent(entity.content)
    return content.length ? content : null
  }

  const catalystHit = await tryFetch(catalystContentAssetUrl(contentUrl, trimmed))
  if (catalystHit) return catalystHit

  return tryFetch(`${WORLDS}/contents/${encodeURIComponent(trimmed)}`)
}

function parcelCoordFromPointer(pointer: string): { x: number; y: number } | null {
  const n = normalizePointer(pointer)
  if (!isParcelPointer(n)) return null
  const [xs, ys] = n.split(',')
  const x = Number(xs)
  const y = Number(ys)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x, y }
}

/** True when the catalyst entity lists `pointer` on pointers, scene.parcels, or base. */
export function catalystEntityClaimsPointer(
  entity: Record<string, unknown>,
  pointer: string
): boolean {
  const want = normalizePointer(pointer)
  const pointers = Array.isArray(entity.pointers)
    ? entity.pointers.filter((p): p is string => typeof p === 'string')
    : []
  if (pointers.some((p) => normalizePointer(p) === want)) return true
  const meta =
    entity.metadata && typeof entity.metadata === 'object'
      ? (entity.metadata as Record<string, unknown>)
      : {}
  const scene =
    meta.scene && typeof meta.scene === 'object' ? (meta.scene as Record<string, unknown>) : {}
  const parcels = Array.isArray(scene.parcels)
    ? scene.parcels.filter((p): p is string => typeof p === 'string')
    : []
  if (parcels.some((p) => normalizePointer(p) === want)) return true
  const base = typeof scene.base === 'string' ? scene.base : ''
  return base.length > 0 && normalizePointer(base) === want
}

function pickClaimingEntity(
  data: unknown,
  pointer: string
): { id: string; entity: Record<string, unknown> } | null {
  if (!Array.isArray(data)) return null
  for (const row of data) {
    if (!row || typeof row !== 'object') continue
    const entity = row as Record<string, unknown>
    if (!catalystEntityClaimsPointer(entity, pointer)) continue
    const id = typeof entity.id === 'string' ? entity.id : null
    if (!id) continue
    return { id, entity: { ...entity, id } }
  }
  return null
}

async function postEntitiesActive(
  contentUrl: string,
  pointers: string[]
): Promise<unknown> {
  const res = await fetchWithTimeout(catalystEntitiesActiveUrl(contentUrl), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointers: pointers.map(normalizePointer) }),
    timeoutMs: CATALYST_FETCH_TIMEOUT_MS
  })
  if (!res.ok) return null
  return res.json().catch(() => null)
}

export async function fetchSceneEntityByPointer(
  contentUrl: string,
  pointer: string
): Promise<{ id: string; entity: Record<string, unknown> } | null> {
  const want = normalizePointer(pointer)
  const direct = pickClaimingEntity(await postEntitiesActive(contentUrl, [want]), want)
  if (direct) return direct

  // Catalyst pointer index can omit a cell the deployment still claims
  // (POST `125,104` empty; the entity at `125,103` lists both parcels).
  const coord = parcelCoordFromPointer(want)
  if (!coord) return null
  const neighbors = [
    `${coord.x + 1},${coord.y}`,
    `${coord.x - 1},${coord.y}`,
    `${coord.x},${coord.y + 1}`,
    `${coord.x},${coord.y - 1}`
  ]
  return pickClaimingEntity(await postEntitiesActive(contentUrl, neighbors), want)
}

/** Deployment entity id at a Genesis base parcel via Catalyst content API. */
export async function resolveSceneIdForPointer(
  contentUrl: string,
  pointer: string
): Promise<string | null> {
  const result = await fetchSceneEntityByPointer(contentUrl, pointer)
  return result?.id ?? null
}

/**
 * World deployment CID.
 * Official servers: asset-bundle-registry first, then `/about`.
 * Custom servers: `/about` only (no registry entry).
 */
export async function resolveWorldSceneId(
  worldName: string,
  customServer?: string | null
): Promise<string | null> {
  const pointer = normalizePointer(worldName)
  const server = worldsContentBase(customServer)

  if (isOfficialWorldsServer(server)) {
    try {
      const res = await fetchWithTimeout(
        `${ASSET_BUNDLE_REGISTRY}/entities/active?world_name=${encodeURIComponent(pointer)}`,
        {
          method: 'POST',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ pointers: ['0,0'] }),
          timeoutMs: CATALYST_FETCH_TIMEOUT_MS
        }
      )
      if (res.ok) {
        const data = (await res.json()) as unknown
        if (Array.isArray(data) && data.length > 0) {
          const id = (data[0] as { id?: string })?.id
          if (typeof id === 'string' && id.length > 0) return id
        }
      }
    } catch {
      /* fallback */
    }
  }

  const aboutRes = await fetchWithTimeout(worldsAboutUrl(server, pointer), {
    headers: { Accept: 'application/json' },
    timeoutMs: CATALYST_FETCH_TIMEOUT_MS
  })
  if (!aboutRes.ok) return null
  const about = (await aboutRes.json()) as { configurations?: { scenesUrn?: string[] } }
  const urn = about.configurations?.scenesUrn?.[0]
  return typeof urn === 'string' ? entityIdFromScenesUrn(urn) : null
}

export async function resolveCommsSceneId(
  pointer: string,
  contentUrl: string,
  entityIdHint?: string | null,
  customServer?: string | null
): Promise<string | null> {
  if (entityIdHint?.trim()) return entityIdHint.trim()
  const normalized = normalizePointer(pointer)
  if (isParcelPointer(normalized)) {
    return resolveSceneIdForPointer(contentUrl, normalized)
  }
  return resolveWorldSceneId(normalized, customServer)
}
