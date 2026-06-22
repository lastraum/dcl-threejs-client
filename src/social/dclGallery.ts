/**
 * Decentraland Camera Reel / Gallery — https://docs.decentraland.org/apis/apis/camera-reel
 */

import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'

const CAMERA_REEL_API = 'https://camera-reel-service.decentraland.org/api'

export const GALLERY_MAX_PHOTOS_DEFAULT = 500

export type DclGalleryImage = {
  id: string
  url: string
  thumbnailUrl: string
  isPublic: boolean
  dateTime: string
}

export type DclGalleryData = {
  images: DclGalleryImage[]
  currentImages: number
  maxImages: number
}

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

export async function fetchUserGallery(
  userAddress: string,
  identity?: AuthIdentity | null
): Promise<DclGalleryData> {
  const address = userAddress.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error('Wallet address required to load gallery')
  }

  const url = `${CAMERA_REEL_API}/users/${address}/images?compact=true&limit=500`
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
    const ta = Date.parse(a.dateTime)
    const tb = Date.parse(b.dateTime)
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta
    if (Number.isFinite(tb)) return 1
    if (Number.isFinite(ta)) return -1
    return 0
  })

  const sections: GalleryMonthSection[] = []
  const indexByKey = new Map<string, number>()

  for (const image of sorted) {
    const d = Date.parse(image.dateTime)
    const date = Number.isFinite(d) ? new Date(d) : null
    const key = date
      ? `${date.getFullYear()}-${String(date.getMonth()).padStart(2, '0')}`
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