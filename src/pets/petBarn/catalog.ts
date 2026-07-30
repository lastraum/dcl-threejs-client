import { petBarnCatalogUrl } from './config'
import type { PetBarnCatalog, PetBarnListing } from './types'
import { normalizePetCategory } from '../petCategories'

function normalizeListing(raw: Record<string, unknown>): PetBarnListing | null {
  const id = String(raw.id ?? '').trim()
  const glbCid = String(raw.glbCid ?? '').trim()
  const thumbnailCid = String(raw.thumbnailCid ?? '').trim()
  const petName = String(raw.petName ?? '').trim()
  if (!id || !glbCid || !thumbnailCid || !petName) return null
  const clipNames = Array.isArray(raw.clipNames)
    ? raw.clipNames.filter((n): n is string => typeof n === 'string' && n.trim().length > 0)
    : undefined
  return {
    id,
    petName,
    creatorName: String(raw.creatorName ?? 'unknown').trim() || 'unknown',
    type: normalizePetCategory(raw.type),
    animationCount: typeof raw.animationCount === 'number' ? raw.animationCount : 0,
    clipNames,
    parcel: String(raw.parcel ?? '').trim(),
    glbFile: typeof raw.glbFile === 'string' ? raw.glbFile : undefined,
    glbCid,
    thumbnailFile: typeof raw.thumbnailFile === 'string' ? raw.thumbnailFile : undefined,
    thumbnailCid,
    sizeBytes: typeof raw.sizeBytes === 'number' ? raw.sizeBytes : 0,
    thumbnailSizeBytes:
      typeof raw.thumbnailSizeBytes === 'number' ? raw.thumbnailSizeBytes : undefined,
    submittedAt: typeof raw.submittedAt === 'string' ? raw.submittedAt : undefined,
    deployedAt: String(raw.deployedAt ?? '').trim() || new Date(0).toISOString(),
    wallet: typeof raw.wallet === 'string' ? raw.wallet : undefined
  }
}

export async function fetchPetBarnCatalog(signal?: AbortSignal): Promise<PetBarnCatalog> {
  const url = petBarnCatalogUrl()
  // Cache-bust: raw.githubusercontent.com can lag; query helps some caches.
  const sep = url.includes('?') ? '&' : '?'
  const res = await fetch(`${url}${sep}t=${Date.now()}`, {
    method: 'GET',
    signal,
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  })
  if (!res.ok) {
    throw new Error(`Catalog fetch failed (${res.status})`)
  }
  const json = (await res.json()) as Record<string, unknown>
  const petsRaw = Array.isArray(json.pets) ? json.pets : []
  const pets: PetBarnListing[] = []
  for (const row of petsRaw) {
    if (!row || typeof row !== 'object') continue
    const n = normalizeListing(row as Record<string, unknown>)
    if (n) pets.push(n)
  }
  const next = (json.nextParcel as { x?: number; y?: number }) || {}
  return {
    version: typeof json.version === 'number' ? json.version : 1,
    world: String(json.world ?? 'petbarn.dcl.eth'),
    contentBaseUrl: String(
      json.contentBaseUrl ?? 'https://worlds-content-server.decentraland.org/contents/'
    ),
    updatedAt: String(json.updatedAt ?? ''),
    nextParcel: {
      x: typeof next.x === 'number' ? next.x : 0,
      y: typeof next.y === 'number' ? next.y : 0
    },
    pets
  }
}
