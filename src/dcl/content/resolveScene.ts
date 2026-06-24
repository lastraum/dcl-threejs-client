import type { RouteTarget } from './route'
import type { ContentFile, RealmEndpoints, ResolvedScene, SceneMetadata, SceneSpawn, SpawnPoint } from './types'
import { BLANK_SCENE_TEMPLATE } from './types'
import { layoutFromSceneMetadata } from './sceneLayout'
import { resolveSceneEnvironment } from '../landscape/resolveLandscapeEnvironment'
import { catalystContentAssetUrl, catalystRootFromContentUrl, fetchSceneEntityByPointer } from '../../network/catalyst/CatalystClient'
import { fetchCatalystRealmAbout, fetchWorldRealmAbout } from '../../network/catalyst/realmAbout'

const WORLDS = 'https://worlds-content-server.decentraland.org'

function entityIdFromUrn(urn: string): string | null {
  const prefix = 'urn:decentraland:entity:'
  if (!urn.startsWith(prefix)) return null
  return urn.slice(prefix.length).split(/[?&#]/)[0]?.trim() || null
}

function parseContent(raw: unknown): ContentFile[] {
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

function pickSpawnCoord(value: number | number[] | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (Array.isArray(value)) {
    const min = value[0] ?? fallback
    const max = value[1] ?? min
    return min + Math.random() * (max - min)
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pickSpawn(metadata: SceneMetadata): SceneSpawn {
  const points = metadata.spawnPoints
  if (!Array.isArray(points) || points.length === 0) {
    return { x: 0, y: 0, z: 0 }
  }
  const def = points.find((p: SpawnPoint) => p.default) ?? points[0]
  const pos = def?.position
  const cameraTarget = def?.cameraTarget
  return {
    x: pickSpawnCoord(pos?.x, 0),
    y: Math.max(0, pickSpawnCoord(pos?.y, 0)),
    z: pickSpawnCoord(pos?.z, 0),
    cameraTarget: cameraTarget
      ? { x: cameraTarget.x, y: cameraTarget.y, z: cameraTarget.z }
      : undefined
  }
}

function findMainEntry(content: ContentFile[], metadata: SceneMetadata): string | null {
  if (typeof metadata.main === 'string' && metadata.main.trim()) return metadata.main.trim()
  return (
    content.find((f) => f.file === 'bin/scene.js')?.file ??
    content.find((f) => f.file === 'bin/index.js')?.file ??
    null
  )
}

function resolveSceneAssetRef(
  src: string,
  content: ContentFile[],
  assetUrl: (hash: string) => string
): string | null {
  const trimmed = src.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return assetUrl(trimmed)
  const hit = content.find((c) => c.file === trimmed || c.file.endsWith(`/${trimmed}`))
  return hit ? assetUrl(hit.hash) : null
}

function worldPointersForTarget(target: Extract<RouteTarget, { kind: 'world' }>): string[] {
  const out: string[] = []
  const add = (name: string) => {
    const trimmed = name.trim()
    if (trimmed && !out.includes(trimmed)) out.push(trimmed)
  }

  add(target.worldName)
  add(target.segment)

  if (!target.segment.includes('.')) {
    add(`${target.segment}.dcl.eth`)
  }

  return out
}

function realmFromAbout(about: Awaited<ReturnType<typeof fetchWorldRealmAbout>>): RealmEndpoints {
  return {
    realmName: about.realmName,
    networkId: about.networkId,
    contentUrl: catalystRootFromContentUrl(about.contentUrl),
    lambdasUrl: about.lambdasUrl,
    commsAdapterHint: about.commsAdapterHint
  }
}

async function fetchWorldEntity(worldName: string): Promise<{
  entity: Record<string, unknown>
  skybox?: { textures?: string[] }
  realm: RealmEndpoints
} | null> {
  const about = await fetchWorldRealmAbout(worldName).catch(() => null)
  if (!about) return null

  const aboutRes = await fetch(`${WORLDS}/world/${encodeURIComponent(worldName)}/about`, {
    headers: { Accept: 'application/json' }
  })
  if (!aboutRes.ok) return null

  const aboutJson = (await aboutRes.json()) as {
    configurations?: { scenesUrn?: string[]; skybox?: { textures?: string[] } }
  }
  const urn = aboutJson.configurations?.scenesUrn?.[0]
  if (typeof urn !== 'string') return null

  const entityId = entityIdFromUrn(urn)
  if (!entityId) return null

  const entityRes = await fetch(`${WORLDS}/contents/${encodeURIComponent(entityId)}`, {
    headers: { Accept: 'application/json' }
  })
  if (!entityRes.ok) return null

  const entity = (await entityRes.json()) as Record<string, unknown>
  return {
    entity: { ...entity, id: entityId },
    skybox: aboutJson.configurations?.skybox,
    realm: realmFromAbout(about)
  }
}

async function fetchParcelEntity(x: number, y: number): Promise<{
  entity: Record<string, unknown>
  realm: RealmEndpoints
} | null> {
  const pointer = `${x},${y}`
  const realmAbout = await fetchCatalystRealmAbout().catch(() => null)
  if (!realmAbout) return null

  const result = await fetchSceneEntityByPointer(realmAbout.contentUrl, pointer)
  if (!result) return null

  return {
    entity: result.entity,
    realm: realmFromAbout(realmAbout)
  }
}

function resolvedFromEntity(
  entity: Record<string, unknown>,
  opts: {
    title: string
    commsPointer: string
    realm: RealmEndpoints
    source: ResolvedScene['source']
    contentsBaseUrl: string
    assetUrl: (hash: string) => string
    aboutSkybox?: { textures?: string[] }
  }
): ResolvedScene {
  const metadata = (entity.metadata ?? {}) as SceneMetadata
  const content = parseContent(entity.content)
  const { parcels, base } = layoutFromSceneMetadata(metadata)
  const display = metadata.display
  const skyboxConfig = metadata.skyboxConfig
  const entityId = typeof entity.id === 'string' ? entity.id : null

  const textures = [...(opts.aboutSkybox?.textures ?? [])]
  const displaySky = display?.skybox ?? display?.skyboxTexture
  if (displaySky?.trim()) {
    const resolved = resolveSceneAssetRef(displaySky.trim(), content, opts.assetUrl)
    if (resolved) textures.unshift(resolved)
    else textures.unshift(displaySky.trim())
  }

  const skybox =
    typeof skyboxConfig?.fixedTime === 'number' || textures.length
      ? {
          fixedTime: skyboxConfig?.fixedTime,
          textures: textures.length ? textures : undefined
        }
      : undefined

  const resolvedEnv = resolveSceneEnvironment(metadata, opts.source)

  return {
    title: display?.title ?? opts.title,
    parcels,
    baseParcel: base,
    spawn: pickSpawn(metadata),
    metadata,
    landscapeEnvironment: resolvedEnv.landscapeEnvironment,
    skyLighting: resolvedEnv.skyLighting,
    content,
    contentsBaseUrl: opts.contentsBaseUrl,
    assetUrl: opts.assetUrl,
    source: opts.source,
    entityId,
    mainEntry: findMainEntry(content, metadata),
    skybox,
    commsPointer: opts.commsPointer,
    realm: opts.realm
  }
}

export async function resolveSceneFromRoute(target: RouteTarget): Promise<ResolvedScene> {
  if (target.kind === 'editor') {
    throw new Error('Editor route does not resolve a network scene — use EditorApp')
  }

  if (target.kind === 'blank') {
    const metadata = { ...BLANK_SCENE_TEMPLATE.metadata, environment: 'none' as const }
    const resolvedEnv = resolveSceneEnvironment(metadata, { kind: 'blank' })
    return {
      ...BLANK_SCENE_TEMPLATE,
      metadata,
      landscapeEnvironment: resolvedEnv.landscapeEnvironment,
      skyLighting: resolvedEnv.skyLighting
    }
  }

  if (target.kind === 'coords') {
    const result = await fetchParcelEntity(target.x, target.y)
    if (!result) {
      throw new Error(
        `No deployed scene at parcel ${target.x},${target.y}. Try a parcel with a scene or use a world (e.g. /lastslice.dcl.eth).`
      )
    }
    const pointer = `${target.x},${target.y}`
    return resolvedFromEntity(result.entity, {
      title: pointer,
      commsPointer: pointer,
      realm: result.realm,
      source: { kind: 'coords', x: target.x, y: target.y },
      contentsBaseUrl: catalystRootFromContentUrl(result.realm.contentUrl),
      assetUrl: (hash) => catalystContentAssetUrl(result.realm.contentUrl, hash)
    })
  }

  const tried: string[] = []
  for (const pointer of worldPointersForTarget(target)) {
    tried.push(pointer)
    const result = await fetchWorldEntity(pointer)
    if (!result) continue

    const entityId = typeof result.entity.id === 'string' ? result.entity.id : null
    if (!entityId) continue

    return resolvedFromEntity(result.entity, {
      title: pointer,
      commsPointer: pointer.toLowerCase(),
      realm: result.realm,
      source: { kind: 'world', worldName: pointer, entityId },
      contentsBaseUrl: WORLDS,
      assetUrl: (hash) => `${WORLDS}/contents/${encodeURIComponent(hash)}`,
      aboutSkybox: result.skybox
    })
  }

  throw new Error(`World not found (${tried.join(' → ')}). Check the name on worlds-content-server.`)
}

/** @deprecated Prefer `resolveSceneFromRoute(resolveRouteTarget())`. */
export async function resolveScene(worldName?: string | null): Promise<ResolvedScene> {
  if (!worldName?.trim()) return { ...BLANK_SCENE_TEMPLATE }
  return resolveSceneFromRoute({
    kind: 'world',
    worldName: worldName.trim(),
    segment: worldName.trim()
  })
}

export function summarizeSceneContent(scene: ResolvedScene): string {
  const binFiles = scene.content.filter((f) => f.file.startsWith('bin/')).length
  const gltfFiles = scene.content.filter((f) => /\.(glb|gltf)$/i.test(f.file)).length
  const lines = [
    `<b>${scene.title}</b>`,
    `Content: ${scene.content.length} files (${binFiles} bin, ${gltfFiles} glTF)`,
    `Realm: ${scene.realm.realmName}`
  ]

  if (scene.source.kind === 'world') {
    lines.push(`World: ${scene.source.worldName}`)
    lines.push(`Entity: <code>${scene.entityId?.slice(0, 18)}…</code>`)
  }

  if (scene.mainEntry) {
    const main = scene.content.find((f) => f.file === scene.mainEntry)
    lines.push(`Main: <code>${scene.mainEntry}</code>${main ? ` · ${main.hash.slice(0, 12)}…` : ''}`)
  }

  return lines.join('<br>')
}
