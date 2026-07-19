/**
 * Decentraland Camera Reel / Gallery — https://docs.decentraland.org/apis/apis/camera-reel
 */

import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import { placesApiBase } from '../map/mapConfig'
import { filterNonDefaultWearables } from '../client/ui/profile/wearableThumb'
import type { PhotoMetadata } from '../photo/photoMetadata'

const CAMERA_REEL_API = 'https://camera-reel-service.decentraland.org/api'

export const GALLERY_MAX_PHOTOS_DEFAULT = 500

export type DclGalleryImage = {
  id: string
  url: string
  thumbnailUrl: string
  isPublic: boolean
  dateTime: string
}

/** Full image payload from GET /api/images/{id}/metadata */
export type DclGalleryImageDetail = DclGalleryImage & {
  metadata: CameraReelUploadMetadata
}

export type DclGalleryData = {
  images: DclGalleryImage[]
  currentImages: number
  maxImages: number
}

/** Exact JSON shape expected by POST /api/images `metadata` part (camelCase). */
export type CameraReelUploadMetadata = {
  userName: string
  userAddress: string
  dateTime: string
  realm: string
  scene: {
    name: string
    location: { x: string; y: string }
  }
  visiblePeople: Array<{
    userName: string
    userAddress: string
    wearables: string[]
    isGuest?: boolean
    isEmoting?: boolean | null
  }>
  placeId: string
}

export type UploadGalleryImageResult = {
  image: DclGalleryImage
  currentImages: number
  maxImages: number
}

const placeIdCache = new Map<string, string>()

export type GalleryMonthSection = {
  key: string
  label: string
  images: DclGalleryImage[]
}

export function galleryReelsUrl(imageId: string): string {
  return `https://reels.decentraland.org/${encodeURIComponent(imageId.trim())}`
}

/** X compose intent text for sharing an in-world gallery photo. */
export const GALLERY_SHARE_ON_X_TEXT =
  'Happening right now in @decentraland.\n\nCome hang out 👋\n\n'

export function galleryShareOnXUrl(image: DclGalleryImage): string {
  const params = new URLSearchParams()
  params.set('text', GALLERY_SHARE_ON_X_TEXT)
  params.set('url', galleryReelsUrl(image.id))
  return `https://x.com/intent/post?${params.toString()}`
}

function mapGalleryImage(raw: unknown): DclGalleryImage | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const id = typeof o.id === 'string' ? o.id.trim() : ''
  if (!id) return null
  const url = typeof o.url === 'string' && o.url.trim() ? o.url.trim() : ''
  const thumb =
    typeof o.thumbnailUrl === 'string' && o.thumbnailUrl.trim()
      ? o.thumbnailUrl.trim()
      : url
  const dateTime =
    typeof o.dateTime === 'string'
      ? o.dateTime
      : typeof o.metadata === 'object' &&
          o.metadata &&
          typeof (o.metadata as Record<string, unknown>).dateTime === 'string'
        ? String((o.metadata as Record<string, unknown>).dateTime)
        : ''
  return {
    id,
    url: url || thumb,
    thumbnailUrl: thumb || url,
    isPublic: o.isPublic === true,
    dateTime
  }
}

function mapCameraReelMetadata(raw: unknown): CameraReelUploadMetadata | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const sceneRaw = o.scene && typeof o.scene === 'object' ? (o.scene as Record<string, unknown>) : {}
  const locRaw =
    sceneRaw.location && typeof sceneRaw.location === 'object'
      ? (sceneRaw.location as Record<string, unknown>)
      : {}
  const peopleRaw = Array.isArray(o.visiblePeople) ? o.visiblePeople : []
  const visiblePeople = peopleRaw
    .map((p) => {
      if (!p || typeof p !== 'object') return null
      const row = p as Record<string, unknown>
      const userAddress = typeof row.userAddress === 'string' ? row.userAddress.trim() : ''
      const userName = typeof row.userName === 'string' ? row.userName.trim() : 'Unknown'
      const wearables = Array.isArray(row.wearables)
        ? row.wearables.filter((u): u is string => typeof u === 'string')
        : []
      return {
        userName: userName || 'Unknown',
        userAddress,
        wearables,
        isGuest: row.isGuest === true,
        isEmoting: typeof row.isEmoting === 'boolean' ? row.isEmoting : null
      }
    })
    .filter((p): p is NonNullable<typeof p> => !!p)

  return {
    userName: typeof o.userName === 'string' ? o.userName : 'Unknown',
    userAddress: typeof o.userAddress === 'string' ? o.userAddress.toLowerCase() : '',
    dateTime: typeof o.dateTime === 'string' ? o.dateTime : '',
    realm: typeof o.realm === 'string' ? o.realm : '',
    scene: {
      name: typeof sceneRaw.name === 'string' ? sceneRaw.name : 'Unknown place',
      location: {
        x: locRaw.x != null ? String(locRaw.x) : '0',
        y: locRaw.y != null ? String(locRaw.y) : '0'
      }
    },
    visiblePeople,
    placeId: typeof o.placeId === 'string' ? o.placeId : ''
  }
}

function mapGalleryImageDetail(raw: unknown): DclGalleryImageDetail | null {
  const base = mapGalleryImage(raw)
  if (!base) return null
  const o = raw as Record<string, unknown>
  const metadata = mapCameraReelMetadata(o.metadata)
  if (!metadata) {
    return {
      ...base,
      metadata: {
        userName: 'Unknown',
        userAddress: '',
        dateTime: base.dateTime,
        realm: '',
        scene: { name: 'Unknown place', location: { x: '0', y: '0' } },
        visiblePeople: [],
        placeId: ''
      }
    }
  }
  if (!base.dateTime && metadata.dateTime) {
    base.dateTime = metadata.dateTime
  }
  return { ...base, metadata }
}

/** Public GET — full image + metadata (people, place, taker). */
export async function fetchGalleryImageDetail(imageId: string): Promise<DclGalleryImageDetail> {
  const id = imageId.trim()
  if (!id) throw new Error('Image id required')
  const res = await fetch(`${CAMERA_REEL_API}/images/${encodeURIComponent(id)}/metadata`, {
    headers: { Accept: 'application/json' }
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && typeof (body as { message?: string }).message === 'string'
        ? (body as { message: string }).message
        : `Gallery image ${res.status}`
    throw new Error(msg)
  }
  const mapped = mapGalleryImageDetail(body)
  if (!mapped) throw new Error('Invalid gallery image response')
  return mapped
}

/** PATCH /api/images/{id}/visibility — requires signed identity. */
export async function updateGalleryImageVisibility(
  imageId: string,
  isPublic: boolean,
  identity: AuthIdentity
): Promise<void> {
  const id = imageId.trim()
  if (!id) throw new Error('Image id required')
  const res = await signedFetch(`${CAMERA_REEL_API}/images/${encodeURIComponent(id)}/visibility`, {
    method: 'PATCH',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ is_public: isPublic }),
    identity
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(body.message?.trim() || `Could not update visibility (${res.status})`)
  }
}

/** DELETE /api/images/{id} — requires signed identity. */
export async function deleteGalleryImage(
  imageId: string,
  identity: AuthIdentity
): Promise<{ currentImages: number; maxImages: number }> {
  const id = imageId.trim()
  if (!id) throw new Error('Image id required')
  const res = await signedFetch(`${CAMERA_REEL_API}/images/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: { Accept: 'application/json' },
    identity
  })
  const body = (await res.json().catch(() => ({}))) as {
    message?: string
    currentImages?: unknown
    maxImages?: unknown
  }
  if (!res.ok) {
    throw new Error(body.message?.trim() || `Could not delete photo (${res.status})`)
  }
  return {
    currentImages:
      typeof body.currentImages === 'number' && Number.isFinite(body.currentImages)
        ? Math.max(0, Math.floor(body.currentImages))
        : 0,
    maxImages:
      typeof body.maxImages === 'number' && Number.isFinite(body.maxImages)
        ? Math.max(1, Math.floor(body.maxImages))
        : GALLERY_MAX_PHOTOS_DEFAULT
  }
}

/**
 * Resolve Places API id for a parcel (Camera Reel metadata.placeId).
 * Falls back to empty string when unknown — upload still succeeds.
 */
export async function resolvePlaceIdForParcel(parcelX: number, parcelY: number): Promise<string> {
  const key = `${parcelX},${parcelY}`
  if (placeIdCache.has(key)) return placeIdCache.get(key)!
  try {
    const base = placesApiBase().replace(/\/$/, '')
    const url = `${base}/places?positions=${encodeURIComponent(key)}&limit=1`
    const res = await fetch(url, { headers: { Accept: 'application/json' } })
    if (!res.ok) {
      placeIdCache.set(key, '')
      return ''
    }
    const body = (await res.json()) as { data?: Array<{ id?: string }> }
    const id = typeof body.data?.[0]?.id === 'string' ? body.data[0].id.trim() : ''
    placeIdCache.set(key, id)
    return id
  } catch {
    placeIdCache.set(key, '')
    return ''
  }
}

/** Map local capture metadata → Camera Reel upload JSON. */
export function photoMetadataToCameraReel(
  meta: PhotoMetadata,
  placeId = ''
): CameraReelUploadMetadata {
  return {
    userName: meta.userName || 'Unknown',
    userAddress: (meta.userAddress || '').toLowerCase(),
    dateTime: meta.dateTime || String(Math.floor(Date.now() / 1000)),
    realm: meta.realm || 'unknown',
    scene: {
      name: meta.scene?.name?.trim() || `Parcel ${meta.scene?.parcelX ?? 0},${meta.scene?.parcelY ?? 0}`,
      location: {
        x: String(meta.scene?.parcelX ?? 0),
        y: String(meta.scene?.parcelY ?? 0)
      }
    },
    visiblePeople: (meta.visiblePeople ?? []).map((p) => ({
      userName: p.userName || 'Unknown',
      userAddress: (p.userAddress || '').toLowerCase(),
      wearables: filterNonDefaultWearables(p.wearables ?? []),
      isGuest: !!p.isGuest,
      isEmoting: p.isEmoting ?? false
    })),
    placeId: placeId || ''
  }
}

/**
 * Upload a screenshot to the user's Camera Reel gallery.
 * Auth: Signed Fetch (ADR-44). metadata.userAddress must match the signed wallet.
 * Does NOT trigger a browser download.
 */
export async function uploadGalleryImage(args: {
  image: Blob
  metadata: CameraReelUploadMetadata
  identity: AuthIdentity
  isPublic?: boolean
  filename?: string
}): Promise<UploadGalleryImageResult> {
  const address = (args.metadata.userAddress || '').toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error('Wallet address required to save to gallery')
  }
  if (args.metadata.userAddress !== address) {
    args.metadata.userAddress = address
  }

  const filename = args.filename ?? `dcl-photo-${args.metadata.dateTime || Date.now()}.jpg`
  const mime = args.image.type || 'image/jpeg'
  if (mime !== 'image/jpeg' && mime !== 'image/png') {
    throw new Error('Gallery only accepts JPEG or PNG')
  }
  if (args.image.size > 5 * 1024 * 1024) {
    throw new Error('Photo is too large (max 5 MB)')
  }

  const form = new FormData()
  form.append('image', args.image, filename)
  form.append(
    'metadata',
    new Blob([JSON.stringify(args.metadata)], { type: 'application/json' }),
    'metadata.json'
  )
  form.append('is_public', args.isPublic === false ? 'false' : 'true')

  const res = await signedFetch(`${CAMERA_REEL_API}/images`, {
    method: 'POST',
    body: form,
    identity: args.identity
  })

  const body = (await res.json().catch(() => ({}))) as {
    message?: string
    reason?: string
    image?: unknown
    currentImages?: unknown
    maxImages?: unknown
  }

  if (!res.ok) {
    if (res.status === 403 || body.reason === 'maxLimitReached') {
      throw new Error(body.message?.trim() || 'Gallery is full — delete some photos first')
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error(body.message?.trim() || 'Sign in with your wallet to save to gallery')
    }
    throw new Error(body.message?.trim() || `Gallery upload failed (${res.status})`)
  }

  const mapped = mapGalleryImage(body.image)
  if (!mapped) {
    throw new Error('Gallery upload succeeded but response was invalid')
  }

  const currentImages =
    typeof body.currentImages === 'number' && Number.isFinite(body.currentImages)
      ? Math.max(0, Math.floor(body.currentImages))
      : 0
  const maxImages =
    typeof body.maxImages === 'number' && Number.isFinite(body.maxImages)
      ? Math.max(1, Math.floor(body.maxImages))
      : GALLERY_MAX_PHOTOS_DEFAULT

  return { image: mapped, currentImages, maxImages }
}

/**
 * Camera Reel `dateTime` is often unix **seconds** as a string (Explorer upload).
 * Also accepts ISO strings and millisecond timestamps.
 */
export function parseGalleryDateTime(raw: string | number | null | undefined): Date | null {
  if (raw == null || raw === '') return null
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    // Heuristic: < 1e12 → seconds, else ms
    const ms = raw < 1e12 ? raw * 1000 : raw
    const d = new Date(ms)
    return Number.isFinite(d.getTime()) ? d : null
  }
  const s = String(raw).trim()
  if (!s) return null
  if (/^\d{9,12}$/.test(s)) {
    const sec = Number(s)
    if (Number.isFinite(sec)) {
      const d = new Date(sec * 1000)
      return Number.isFinite(d.getTime()) ? d : null
    }
  }
  if (/^\d{13,}$/.test(s)) {
    const ms = Number(s)
    if (Number.isFinite(ms)) {
      const d = new Date(ms)
      return Number.isFinite(d.getTime()) ? d : null
    }
  }
  const parsed = Date.parse(s)
  if (Number.isFinite(parsed)) return new Date(parsed)
  return null
}

export function formatGalleryDateTime(
  raw: string | number | null | undefined,
  style: 'short' | 'medium' = 'medium'
): string {
  const d = parseGalleryDateTime(raw)
  if (!d) return 'Date unknown'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: style === 'short' ? 'medium' : 'long',
    timeStyle: 'short'
  }).format(d)
}

export async function fetchUserGallery(
  userAddress: string,
  identity?: AuthIdentity | null
): Promise<DclGalleryData> {
  const address = userAddress.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error('Wallet address required to load gallery')
  }

  // API clamps limit to 100 — page if we ever need more.
  const url = `${CAMERA_REEL_API}/users/${address}/images?compact=true&limit=100&offset=0`
  const res = identity
    ? await signedFetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        identity
      })
    : await fetch(url, { headers: { Accept: 'application/json' } })

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { message?: string }
    throw new Error(body.message ?? `Gallery API ${res.status}`)
  }

  const body = (await res.json()) as {
    images?: unknown
    currentImages?: unknown
    maxImages?: unknown
  }

  const images: DclGalleryImage[] = []
  if (Array.isArray(body.images)) {
    for (const item of body.images) {
      const row = mapGalleryImage(item)
      if (row) images.push(row)
    }
  }

  const currentImages =
    typeof body.currentImages === 'number' && Number.isFinite(body.currentImages)
      ? Math.max(0, Math.floor(body.currentImages))
      : images.length
  const maxImages =
    typeof body.maxImages === 'number' && Number.isFinite(body.maxImages)
      ? Math.max(1, Math.floor(body.maxImages))
      : GALLERY_MAX_PHOTOS_DEFAULT

  return { images, currentImages, maxImages }
}

export function groupGalleryByMonth(images: DclGalleryImage[]): GalleryMonthSection[] {
  const sorted = [...images].sort((a, b) => {
    const da = parseGalleryDateTime(a.dateTime)?.getTime() ?? 0
    const db = parseGalleryDateTime(b.dateTime)?.getTime() ?? 0
    return db - da
  })

  const sections: GalleryMonthSection[] = []
  const indexByKey = new Map<string, number>()

  for (const image of sorted) {
    const date = parseGalleryDateTime(image.dateTime)
    const key = date
      ? `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`
      : 'unknown'
    const label = date
      ? new Intl.DateTimeFormat(undefined, { month: 'long', year: 'numeric' }).format(date)
      : 'Photos'

    let idx = indexByKey.get(key)
    if (idx === undefined) {
      idx = sections.length
      indexByKey.set(key, idx)
      sections.push({ key, label, images: [] })
    }
    sections[idx]!.images.push(image)
  }

  return sections
}