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
  return scene.source.kind === 'local' || previewOriginFromScene(scene) != null
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
    configurations?: { scenesUrn?: string[]; realmName?: string; networkId?: number }
    content?: { publicUrl?: string }
    lambdas?: { publicUrl?: string }
  }
  const urn = aboutJson.configurations?.scenesUrn?.[0]
  if (typeof urn !== 'string') return null
  const entityId = entityIdFromScenesUrn(urn)
  if (!entityId) return null

  const urnContents = contentBaseFromScenesUrn(urn)
  const contentsRoot = (urnContents ?? aboutJson.content?.publicUrl ?? `${origin}/contents`).replace(
    /\/+$/,
    ''
  )
  const entityRes = await fetch(`${contentsRoot}/${encodeURIComponent(entityId)}`, {
    headers: { Accept: 'application/json' },
    cache: 'no-store'
  })
  if (!entityRes.ok) return null
  const entity = (await entityRes.json()) as {
    id?: string
    metadata?: SceneMetadata
    content?: Array<{ file?: string; hash?: string }>
  }
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
    parcels: parcels.length ? parcels : prev.parcels,
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
