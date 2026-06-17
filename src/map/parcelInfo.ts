import { catalystPeerBaseUrl, parcelsApiBase } from './mapConfig'
import type { ParcelInfo } from './types'

type ParcelsApiResponse = {
  id?: string
  name?: string
  description?: string
  image?: string
  attributes?: Array<{ trait_type?: string; value?: number }>
}

type CatalystContentFile = {
  file?: string
  hash?: string
}

type CatalystEntity = {
  content?: CatalystContentFile[]
  metadata?: {
    name?: string
    description?: string
    display?: { title?: string; description?: string }
  }
}

function coordsFromAttributes(
  attrs: ParcelsApiResponse['attributes'],
  px: number,
  py: number
): { px: number; py: number } {
  let x = px
  let y = py
  for (const row of attrs ?? []) {
    if (row.trait_type === 'X' && Number.isFinite(row.value)) x = Number(row.value)
    if (row.trait_type === 'Y' && Number.isFinite(row.value)) y = Number(row.value)
  }
  return { px: x, py: y }
}

export function proxiedParcelAssetUrl(url: string): string {
  const trimmed = url.trim()
  if (!trimmed) return trimmed
  const m = /^https:\/\/api\.decentraland\.org\/v2\/parcels\/(-?\d+)\/(-?\d+)(.*)$/.exec(trimmed)
  if (!m) return trimmed
  return `${parcelsApiBase()}/${m[1]}/${m[2]}${m[3]}`
}

function sceneNameFromEntity(entity: CatalystEntity | undefined): string | null {
  const meta = entity?.metadata
  if (!meta) return null
  const title = meta.display?.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  const name = meta.name
  if (typeof name === 'string' && name.trim()) return name.trim()
  return null
}

function sceneDescriptionFromEntity(entity: CatalystEntity | undefined): string {
  const meta = entity?.metadata
  if (!meta) return ''
  const fromDisplay = meta.display?.description
  if (typeof fromDisplay === 'string' && fromDisplay.trim()) return fromDisplay.trim()
  const desc = meta.description
  if (typeof desc === 'string' && desc.trim()) return desc.trim()
  return ''
}

function sceneThumbnailHash(entity: CatalystEntity | undefined): string | null {
  const files = entity?.content
  if (!Array.isArray(files)) return null

  const exact = files.find((row) => row.file === 'scene-thumbnail.png' && row.hash?.trim())
  if (exact?.hash) return exact.hash.trim()

  const nested = files.find(
    (row) =>
      typeof row.file === 'string' &&
      row.file.endsWith('/scene-thumbnail.png') &&
      row.hash?.trim()
  )
  return nested?.hash?.trim() ?? null
}

export function catalystContentUrl(hash: string): string {
  return `${catalystPeerBaseUrl()}/content/contents/${encodeURIComponent(hash.trim())}`
}

async function fetchSceneAtParcel(px: number, py: number): Promise<CatalystEntity | null> {
  const res = await fetch(`${catalystPeerBaseUrl()}/content/entities/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ pointers: [`${px},${py}`] })
  })
  if (!res.ok) return null
  const data = (await res.json()) as CatalystEntity[]
  return Array.isArray(data) && data.length > 0 ? data[0] : null
}

export async function fetchParcelInfo(px: number, py: number): Promise<ParcelInfo> {
  const [atlasRes, sceneEntity] = await Promise.all([
    fetch(`${parcelsApiBase()}/${px}/${py}`, { headers: { Accept: 'application/json' } }),
    fetchSceneAtParcel(px, py)
  ])

  if (!atlasRes.ok) {
    throw new Error(`Parcel HTTP ${atlasRes.status}`)
  }

  const raw = (await atlasRes.json()) as ParcelsApiResponse
  const coords = coordsFromAttributes(raw.attributes, px, py)
  const imageRaw = String(raw.image ?? '').trim()
  const parcelLabel = String(raw.name ?? `Parcel ${coords.px},${coords.py}`).trim()
  const atlasDescription = String(raw.description ?? '').trim()
  const sceneDescription = sceneDescriptionFromEntity(sceneEntity ?? undefined)
  const thumbHash = sceneThumbnailHash(sceneEntity ?? undefined)
  const sceneImageUrl = thumbHash ? catalystContentUrl(thumbHash) : null
  const atlasImageUrl = proxiedParcelAssetUrl(imageRaw)

  return {
    px: coords.px,
    py: coords.py,
    sceneName: sceneNameFromEntity(sceneEntity ?? undefined),
    parcelLabel,
    description: sceneDescription || atlasDescription,
    imageUrl: sceneImageUrl || atlasImageUrl,
    mapImageUrl: atlasImageUrl
  }
}
