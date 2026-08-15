import type { RealmEndpoints, ResolvedScene } from './types'
import {
  catalystContentAssetUrl,
  catalystRootFromContentUrl,
  fetchSceneEntityByPointer
} from '../../network/catalyst/CatalystClient'
import { ABOUT_FETCH_TIMEOUT_MS, fetchWithTimeout } from '../../util/fetchWithTimeout'
import {
  contentBaseFromScenesUrn,
  entityIdFromScenesUrn
} from '../../network/worlds/worldsServerConfig'
import { DEFAULT_PREVIEW_REALM } from './previewRealm'
import { resolvedFromEntity } from './resolveSceneEntity'

type PreviewAboutJson = {
  healthy?: boolean
  content?: { publicUrl?: string }
  lambdas?: { publicUrl?: string }
  configurations?: {
    realmName?: string
    networkId?: number
    scenesUrn?: string[]
    localSceneParcels?: string[]
  }
}

function previewUnreachableError(realmUrl: string, cause: unknown): Error {
  const detail = cause instanceof Error ? cause.message : String(cause)
  return new Error(
    `PREVIEW_UNREACHABLE: Could not reach Creator Hub preview at ${realmUrl}. ` +
      `Start Preview in Creator Hub (or \`npm run start\` in the scene folder), then reload this tab. ` +
      `If the browser asks to access apps on your device / local network, click Allow. ` +
      `(${detail})`
  )
}

function previewEmptyError(realmUrl: string): Error {
  return new Error(
    `PREVIEW_EMPTY: Preview server at ${realmUrl} is up but returned no scene entity. ` +
      `Confirm Creator Hub Preview is running a scene, then reload.`
  )
}

function normalizeRealmBase(realmUrl: string): string {
  return realmUrl.trim().replace(/\/+$/, '') || DEFAULT_PREVIEW_REALM
}

function contentUrlFromAbout(base: string, about: PreviewAboutJson | null): string {
  const publicUrl = about?.content?.publicUrl?.trim()
  if (publicUrl) {
    if (/^https?:\/\//i.test(publicUrl)) return publicUrl.replace(/\/+$/, '')
    return `${base}/${publicUrl.replace(/^\/+/, '')}`.replace(/\/+$/, '')
  }
  return `${base}/content`
}

async function fetchJson(url: string): Promise<unknown | null> {
  try {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: 'application/json' },
      timeoutMs: ABOUT_FETCH_TIMEOUT_MS
    })
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function fetchPreviewAbout(base: string): Promise<PreviewAboutJson> {
  try {
    const res = await fetchWithTimeout(`${base}/about`, {
      headers: { Accept: 'application/json' },
      timeoutMs: ABOUT_FETCH_TIMEOUT_MS
    })
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`)
    }
    return (await res.json()) as PreviewAboutJson
  } catch (err) {
    throw previewUnreachableError(base, err)
  }
}

function parcelsFromSceneJson(raw: unknown): string[] {
  if (!raw || typeof raw !== 'object') return []
  const scene = (raw as { scene?: { base?: unknown; parcels?: unknown } }).scene
  const out: string[] = []
  const add = (value: unknown) => {
    if (typeof value === 'string' && /^-?\d+\s*,\s*-?\d+$/.test(value.trim())) {
      const key = value.trim().replace(/\s*,\s*/, ',')
      if (!out.includes(key)) out.push(key)
    }
  }
  if (scene && typeof scene === 'object') {
    add(scene.base)
    if (Array.isArray(scene.parcels)) {
      for (const p of scene.parcels) add(p)
    }
  }
  return out
}

async function fetchEntityById(
  contentUrl: string,
  entityId: string
): Promise<Record<string, unknown> | null> {
  const url = catalystContentAssetUrl(contentUrl, entityId)
  const raw = await fetchJson(url)
  if (!raw || typeof raw !== 'object') return null
  const entity = raw as Record<string, unknown>
  return { ...entity, id: typeof entity.id === 'string' ? entity.id : entityId }
}

async function fetchEntityByPointerGet(
  contentUrl: string,
  pointer: string
): Promise<Record<string, unknown> | null> {
  const root = catalystRootFromContentUrl(contentUrl)
  const url = `${root}/content/entities/scene?pointer=${encodeURIComponent(pointer)}`
  const raw = await fetchJson(url)
  const row = Array.isArray(raw) ? raw[0] : raw
  if (!row || typeof row !== 'object') return null
  const entity = row as Record<string, unknown>
  const id = typeof entity.id === 'string' ? entity.id : null
  if (!id) return null
  return { ...entity, id }
}

/**
 * Load the scene Hub Preview is serving on this machine (no deploy).
 * Hub `/about` leaves `scenesUrn` empty — entity comes from `/content/entities/active`.
 */
export async function resolvePreviewScene(realmUrl: string): Promise<ResolvedScene> {
  const base = normalizeRealmBase(realmUrl)
  const about = await fetchPreviewAbout(base)
  const contentUrl = contentUrlFromAbout(base, about)
  const lambdasUrl =
    about.lambdas?.publicUrl?.trim().replace(/\/+$/, '') || `${base}/lambdas`

  const realm: RealmEndpoints = {
    realmName: about.configurations?.realmName?.trim() || 'LocalPreview',
    networkId: about.configurations?.networkId ?? 0,
    contentUrl,
    lambdasUrl,
    commsEnabled: false
  }

  const sceneJson = await fetchJson(`${base}/scene.json`)
  const parcels = [
    ...(about.configurations?.localSceneParcels ?? []),
    ...parcelsFromSceneJson(sceneJson),
    '0,0'
  ].filter((p, i, all) => typeof p === 'string' && p.trim() && all.indexOf(p) === i)

  let entity: Record<string, unknown> | null = null

  const urn = about.configurations?.scenesUrn?.[0]
  if (typeof urn === 'string') {
    const entityId = entityIdFromScenesUrn(urn)
    const urnContents = contentBaseFromScenesUrn(urn)
    if (entityId) {
      entity = await fetchEntityById(urnContents ?? contentUrl, entityId)
    }
  }

  if (!entity) {
    for (const pointer of parcels) {
      const result = await fetchSceneEntityByPointer(contentUrl, pointer).catch(() => null)
      if (result?.entity) {
        entity = result.entity
        break
      }
      const viaGet = await fetchEntityByPointerGet(contentUrl, pointer)
      if (viaGet) {
        entity = viaGet
        break
      }
    }
  }

  if (!entity) throw previewEmptyError(base)

  const pointer = parcels[0] ?? '0,0'
  const resolved = resolvedFromEntity(entity, {
    title: 'Local preview',
    commsPointer: pointer,
    realm,
    source: { kind: 'preview', realmUrl: base },
    contentsBaseUrl: catalystRootFromContentUrl(contentUrl),
    assetUrl: (hash) => catalystContentAssetUrl(contentUrl, hash)
  })
  console.info(
    `[resolve] Hub preview ${base} — “${resolved.title}” · ${resolved.content.length} files · main ${resolved.mainEntry ?? 'none'}`
  )
  return resolved
}
