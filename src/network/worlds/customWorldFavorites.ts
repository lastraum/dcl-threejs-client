/**
 * Local favorites for custom world servers (not in Places API).
 * Merged into the Places "Favourites" tab alongside wallet profile favourites.
 */

import {
  normalizeCustomServerUrl,
  worldsContentBase
} from './worldsServerConfig'

const STORAGE_KEY = 'dcl-client-custom-world-favorites'
const MAX_ENTRIES = 80

export type CustomWorldFavorite = {
  /** Normalized server origin (https://host). */
  customServer: string
  worldName: string
  title?: string
  addedAt: number
}

function readStore(): CustomWorldFavorite[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return []
    const out: CustomWorldFavorite[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const r = row as Record<string, unknown>
      const customServer = normalizeCustomServerUrl(
        typeof r.customServer === 'string' ? r.customServer : null
      )
      const worldName = typeof r.worldName === 'string' ? r.worldName.trim() : ''
      if (!customServer || !worldName) continue
      out.push({
        customServer,
        worldName,
        title: typeof r.title === 'string' ? r.title : undefined,
        addedAt: typeof r.addedAt === 'number' ? r.addedAt : Date.now()
      })
    }
    return out
  } catch {
    return []
  }
}

function writeStore(entries: CustomWorldFavorite[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)))
  } catch {
    /* quota / private mode */
  }
}

export function customWorldFavoriteKey(customServer: string, worldName: string): string {
  const server = worldsContentBase(customServer).toLowerCase()
  const name = worldName.trim().toLowerCase()
  return `${server}::${name}`
}

export function listCustomWorldFavorites(): CustomWorldFavorite[] {
  return readStore().sort((a, b) => b.addedAt - a.addedAt)
}

export function isCustomWorldFavorite(customServer: string, worldName: string): boolean {
  const key = customWorldFavoriteKey(customServer, worldName)
  return readStore().some((e) => customWorldFavoriteKey(e.customServer, e.worldName) === key)
}

/** Upsert favorite (moves to top by addedAt). */
export function addCustomWorldFavorite(input: {
  customServer: string
  worldName: string
  title?: string
}): CustomWorldFavorite | null {
  const customServer = normalizeCustomServerUrl(input.customServer)
  const worldName = input.worldName.trim()
  if (!customServer || !worldName) return null

  const key = customWorldFavoriteKey(customServer, worldName)
  const rest = readStore().filter(
    (e) => customWorldFavoriteKey(e.customServer, e.worldName) !== key
  )
  const entry: CustomWorldFavorite = {
    customServer,
    worldName,
    title: input.title?.trim() || undefined,
    addedAt: Date.now()
  }
  writeStore([entry, ...rest])
  return entry
}

export function removeCustomWorldFavorite(customServer: string, worldName: string): void {
  const key = customWorldFavoriteKey(customServer, worldName)
  writeStore(
    readStore().filter((e) => customWorldFavoriteKey(e.customServer, e.worldName) !== key)
  )
}
