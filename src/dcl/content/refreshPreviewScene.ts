import type { ContentFile, RealmEndpoints, ResolvedScene, SceneMetadata } from './types'
import { pickSceneSpawn } from './pickSceneSpawn'
import { layoutFromSceneMetadata } from './sceneLayout'
import { resolveBrowserChatEnabled } from './resolveBrowserChat'
import { resolveNameTagsVisible } from './resolveNameTags'
import { resolvePortableExperiencesPolicy } from '../multiScene/resolvePortableExperiences'
import { resolveSceneEnvironment } from '../landscape/resolveLandscapeEnvironment'
import { contentBaseFromScenesUrn, entityIdFromScenesUrn } from '../../network/worlds/worldsServerConfig'
import { isLocalPreviewHttpUrl } from '../../network/preview/wsSceneMessage'

export function previewOriginFromScene(scene: ResolvedScene): string | null {
  for (const raw of [scene.contentsBaseUrl, scene.realm.contentUrl, scene.realm.lambdasUrl]) {
    if (!isLocalPreviewHttpUrl(raw)) continue
    try {
      return new URL(raw).origin
    } catch {
      /* next */
    }
  }
  return null
}

export function isLocalPreviewScene(scene: ResolvedScene): boolean {
  return (
    scene.source.kind === 'preview' ||
    scene.source.kind === 'local' ||
    previewOriginFromScene(scene) != null
  )
}

/** scene.json `display.navmapThumbnail` — hash, relative file, or absolute URL. */
export function previewLandingImageUrl(scene: ResolvedScene): string | null {
  const display = scene.metadata.display as
    | (NonNullable<SceneMetadata['display']> & { navmapThumbnail?: string; favicon?: string })
    | undefined
  const thumb = display?.navmapThumbnail?.trim() || display?.favicon?.trim() || ''
  if (!thumb) return null
  if (/^https?:\/\//i.test(thumb)) return thumb
  const hit =
    scene.content.find((f) => f.file === thumb) ??
    scene.content.find((f) => f.file.endsWith(`/${thumb}`))
  if (hit) return scene.assetUrl(hit.hash)
  const origin =
    scene.source.kind === 'preview' ? scene.source.origin : previewOriginFromScene(scene)
  if (!origin) return null
  return `${origin.replace(/\/+$/, '')}/${thumb.replace(/^\//, '')}`
}

/**
 * First resolve for `/localpreview` — `GET {origin}/about` + entity + optional `scene.json`.
 */
export async function resolveLocalPreviewScene(origin: string): Promise<ResolvedScene> {
  const dummy: ResolvedScene = {
    title: 'Local preview',
    parcels: ['0,0'],
    baseParcel: '0,0',
    spawn: { x: 8, y: 0, z: 8, fromSpawnPoints: false },
    metadata: {},
    landscapeEnvironment: 'none',
    skyLighting: { disableSun: false, disableMoon: false },
    content: [],
    contentsBaseUrl: `${origin.replace(/\/+$/, '')}/contents`,
    assetUrl: (hash) => `${origin.replace(/\/+$/, '')}/contents/${encodeURIComponent(hash)}`,
    source: { kind: 'preview', origin: origin.replace(/\/+$/, '') },
    entityId: null,
    mainEntry: null,
    commsPointer: '0,0',
    browserChatEnabled: false,
    nameTagsVisible: true,
    realm: {
      realmName: 'LocalPreview',
      networkId: 1,
      contentUrl: origin.replace(/\/+$/, ''),
      lambdasUrl: origin.replace(/\/+$/, ''),
      commsEnabled: false
    }
  }
  let refreshed: ResolvedScene | null = null
  try {
    refreshed = await refreshPreviewRealmScene(dummy)
  } catch {
    refreshed = null
  }
  if (refreshed) {
    return { ...refreshed, source: { kind: 'preview', origin: origin.replace(/\/+$/, '') } }
  }
  const sceneJson = await fetchPreviewSceneJson(origin)
  if (sceneJson) {
    const { parcels, base } = layoutFromSceneMetadata(sceneJson)
    const resolvedEnv = resolveSceneEnvironment(sceneJson, dummy.source)
    dummy.metadata = sceneJson
    dummy.title = sceneJson.display?.title?.trim() || 'Local preview'
    dummy.parcels = parcels.length ? parcels : dummy.parcels
    dummy.baseParcel = base || dummy.baseParcel
    dummy.spawn = pickSceneSpawn(sceneJson)
    dummy.landscapeEnvironment = resolvedEnv.landscapeEnvironment
    dummy.skyLighting = resolvedEnv.skyLighting
    dummy.browserChatEnabled = resolveBrowserChatEnabled(sceneJson)
    dummy.nameTagsVisible = resolveNameTagsVisible(sceneJson)
    dummy.portableExperiencesPolicy = resolvePortableExperiencesPolicy(sceneJson)
    dummy.commsPointer = dummy.baseParcel
    return dummy
  }
  throw new Error(
    `LOCAL_PREVIEW_OFFLINE: No preview server at ${origin}. Run \`npm start\` in the scene (sdk-commands) or Play from Creator Hub.`
  )
}

type PreviewEntityPayload = {
  id?: string
  metadata?: SceneMetadata
  content?: Array<{ file?: string; hash?: string }>
}

/** sdk-commands LSD — `/about` often has empty `scenesUrn`; entity is POST `/content/entities/active`. */
async function fetchPreviewActiveEntity(
  origin: string,
  pointers: string[] | undefined
): Promise<PreviewEntityPayload | null> {
  const base = origin.replace(/\/+$/, '')
  const pointer =
    pointers?.find((p) => typeof p === 'string' && /^-?\d+\s*,\s*-?\d+$/.test(p.trim()))?.trim() ||
    '0,0'
  for (const path of ['/content/entities/active', '/entities/active']) {
    try {
      const res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: [pointer] }),
        cache: 'no-store'
      })
      if (!res.ok) continue
      const json = (await res.json()) as unknown
      const first = Array.isArray(json) ? json[0] : null
      if (first && typeof first === 'object') return first as PreviewEntityPayload
    } catch {
      /* next */
    }
  }
  return null
}

async function fetchPreviewSceneJson(origin: string): Promise<SceneMetadata | null> {
  const base = origin.replace(/\/+$/, '')
  for (const path of ['/scene.json', '/content/scene.json', '/contents/scene.json']) {
    try {
      const res = await fetch(`${base}${path}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      })
      if (!res.ok) continue
      const json = (await res.json()) as SceneMetadata
      if (json && typeof json === 'object') return json
    } catch {
      /* next */
    }
  }
  return null
}

/**
 * Re-read sdk-commands / Creator Hub `GET /about` + entity so `/reload` and
 * SCENE_UPDATE pick up a new `bin/index.js` hash (path-stable LSD hashes).
 */
export async function refreshPreviewRealmScene(
  prev: ResolvedScene
): Promise<ResolvedScene | null> {
  const origin = previewOriginFromScene(prev)
  if (!origin) return null

  const aboutRes = await fetch(`${origin.replace(/\/+$/, '')}/about`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  })
  if (!aboutRes.ok) return null
  const aboutJson = (await aboutRes.json()) as {
    configurations?: {
      scenesUrn?: string[]
      localSceneParcels?: string[]
      realmName?: string
      networkId?: number
    }
    content?: { publicUrl?: string }
    lambdas?: { publicUrl?: string }
  }
  const contentPublic = (
    aboutJson.content?.publicUrl ?? `${origin.replace(/\/+$/, '')}/content`
  ).replace(/\/+$/, '')
  const urn = aboutJson.configurations?.scenesUrn?.[0]
  const urnEntityId = typeof urn === 'string' ? entityIdFromScenesUrn(urn) : null
  const urnContents = typeof urn === 'string' ? contentBaseFromScenesUrn(urn) : null
  const contentsRoot = (urnContents ?? `${contentPublic}/contents`).replace(/\/+$/, '')

  let entity: PreviewEntityPayload | null = null
  let entityId = urnEntityId
  if (entityId) {
    try {
      const entityRes = await fetch(`${contentsRoot}/${encodeURIComponent(entityId)}`, {
        headers: { Accept: 'application/json' },
        cache: 'no-store'
      })
      if (entityRes.ok) entity = (await entityRes.json()) as PreviewEntityPayload
    } catch {
      entity = null
    }
  }
  if (!entity) {
    entity = await fetchPreviewActiveEntity(origin, aboutJson.configurations?.localSceneParcels)
    if (entity?.id) entityId = entity.id
  }
  if (!entity) return null
  const metadata = (entity.metadata ?? {}) as SceneMetadata
  const content: ContentFile[] = []
  for (const row of entity.content ?? []) {
    if (typeof row.file === 'string' && typeof row.hash === 'string') {
      content.push({ file: row.file, hash: row.hash })
    }
  }
  const { parcels, base } = layoutFromSceneMetadata(metadata)
  const main =
    (typeof metadata.main === 'string' && metadata.main.trim()) ||
    content.find((f) => f.file === 'bin/index.js')?.file ||
    content.find((f) => f.file === 'bin/scene.js')?.file ||
    prev.mainEntry
  const resolvedEnv = resolveSceneEnvironment(metadata, prev.source)
  const realm: RealmEndpoints = {
    ...prev.realm,
    realmName: aboutJson.configurations?.realmName?.trim() || prev.realm.realmName,
    networkId: aboutJson.configurations?.networkId ?? prev.realm.networkId,
    contentUrl: aboutJson.content?.publicUrl?.replace(/\/contents\/?$/, '') || prev.realm.contentUrl
  }
  return {
    ...prev,
    title: metadata.display?.title?.trim() || prev.title,
    parcels: parcels.length
      ? parcels
      : aboutJson.configurations?.localSceneParcels?.length
        ? aboutJson.configurations.localSceneParcels
        : prev.parcels,
    baseParcel: base || prev.baseParcel,
    spawn: pickSceneSpawn(metadata),
    metadata,
    landscapeEnvironment: resolvedEnv.landscapeEnvironment,
    skyLighting: resolvedEnv.skyLighting,
    content,
    contentsBaseUrl: contentsRoot,
    assetUrl: (hash) => `${contentsRoot}/${encodeURIComponent(hash)}`,
    entityId,
    mainEntry: main,
    commsPointer: prev.commsPointer,
    browserChatEnabled: resolveBrowserChatEnabled(metadata),
    nameTagsVisible: resolveNameTagsVisible(metadata),
    portableExperiencesPolicy: resolvePortableExperiencesPolicy(metadata),
    realm
  }
}
