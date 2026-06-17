import type { ContentFile } from '../../dcl/content/types'
import { isParcelPointer, normalizePointer } from './pointer'

const WORLDS = 'https://worlds-content-server.decentraland.org'

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

function entityIdFromUrn(urn: string): string | null {
  const prefix = 'urn:decentraland:entity:'
  if (!urn.startsWith(prefix)) return null
  return urn.slice(prefix.length).split(/[?&#]/)[0]?.trim() || null
}

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
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) return null
    const entity = (await res.json()) as { content?: unknown }
    const content = parseEntityContent(entity.content)
    return content.length ? content : null
  }

  const catalystHit = await tryFetch(catalystContentAssetUrl(contentUrl, trimmed))
  if (catalystHit) return catalystHit

  return tryFetch(`${WORLDS}/contents/${encodeURIComponent(trimmed)}`)
}

export async function fetchSceneEntityByPointer(
  contentUrl: string,
  pointer: string
): Promise<{ id: string; entity: Record<string, unknown> } | null> {
  const res = await fetch(catalystEntitiesActiveUrl(contentUrl), {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointers: [normalizePointer(pointer)] })
  })
  if (!res.ok) return null

  const data = (await res.json()) as unknown
  if (!Array.isArray(data) || data.length === 0) return null

  const entity = data[0] as Record<string, unknown>
  const id = typeof entity.id === 'string' ? entity.id : null
  if (!id) return null

  return { id, entity: { ...entity, id } }
}

/** Deployment entity id at a Genesis base parcel via Catalyst content API. */
export async function resolveSceneIdForPointer(
  contentUrl: string,
  pointer: string
): Promise<string | null> {
  const result = await fetchSceneEntityByPointer(contentUrl, pointer)
  return result?.id ?? null
}

/** World deployment CID — asset bundle registry first, worlds `/about` fallback. */
export async function resolveWorldSceneId(worldName: string): Promise<string | null> {
  const pointer = normalizePointer(worldName)
  try {
    const res = await fetch(
      `${ASSET_BUNDLE_REGISTRY}/entities/active?world_name=${encodeURIComponent(pointer)}`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: ['0,0'] })
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

  const aboutRes = await fetch(`${WORLDS}/world/${encodeURIComponent(pointer)}/about`, {
    headers: { Accept: 'application/json' }
  })
  if (!aboutRes.ok) return null
  const about = (await aboutRes.json()) as { configurations?: { scenesUrn?: string[] } }
  const urn = about.configurations?.scenesUrn?.[0]
  return typeof urn === 'string' ? entityIdFromUrn(urn) : null
}

export async function resolveCommsSceneId(
  pointer: string,
  contentUrl: string,
  entityIdHint?: string | null
): Promise<string | null> {
  if (entityIdHint?.trim()) return entityIdHint.trim()
  const normalized = normalizePointer(pointer)
  if (isParcelPointer(normalized)) {
    return resolveSceneIdForPointer(contentUrl, normalized)
  }
  return resolveWorldSceneId(normalized)
}
