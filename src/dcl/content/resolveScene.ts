import type { RouteTarget } from './route'
import type { ContentFile, RealmEndpoints, ResolvedScene, SceneMetadata } from './types'
import { pickSceneSpawn } from './pickSceneSpawn'
import { BLANK_SCENE_TEMPLATE } from './types'
import { layoutFromSceneMetadata } from './sceneLayout'
import { resolveBrowserChatEnabled } from './resolveBrowserChat'
import { resolveNameTagsVisible } from './resolveNameTags'
import { resolvePortableExperiencesPolicy } from '../multiScene/resolvePortableExperiences'
import { resolveSceneEnvironment } from '../landscape/resolveLandscapeEnvironment'
import { catalystContentAssetUrl, catalystRootFromContentUrl, fetchSceneEntityByPointer } from '../../network/catalyst/CatalystClient'
import { fetchCatalystRealmAbout, fetchWorldRealmAbout } from '../../network/catalyst/realmAbout'
import {
  contentBaseFromScenesUrn,
  entityIdFromScenesUrn,
  worldsAboutUrl,
  worldsContentBase
} from '../../network/worlds/worldsServerConfig'

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

function findMainEntry(content: ContentFile[], metadata: SceneMetadata): string | null {
  if (typeof metadata.main === 'string' && metadata.main.trim()) return metadata.main.trim()
  return (
    content.find((f) => f.file === 'bin/scene.js')?.file ??
    content.find((f) => f.file === 'bin/index.js')?.file ??
    content.find((f) => f.file === 'bin/game.js')?.file ??
    null
  )
}

/**
 * ThreejsClient only runs SDK7 ECS scenes. Classic Builder SDK6 (`dcl.addEntity` /
 * `bin/game.js`, no runtimeVersion 7) never publishes CRDT → hydration stuck ~78%.
 */
export function assertSdk7CompatibleScene(
  metadata: SceneMetadata,
  mainEntry: string | null,
  label: string
): void {
  const rv = metadata.runtimeVersion
  const rvStr = rv === undefined || rv === null ? '' : String(rv).trim()
  if (rvStr === '7' || rvStr.startsWith('7.')) return
  if (rvStr === '6' || rvStr.startsWith('6.')) {
    throw new Error(
      `SDK6_UNSUPPORTED: "${label}" is an SDK6 scene (runtimeVersion ${rvStr}). This client only runs SDK7 scenes.`
    )
  }
  const main = (mainEntry ?? metadata.main ?? '').trim().toLowerCase()
  // Builder SDK6 default entry; SDK7 deploys use bin/index.js (+ runtimeVersion 7).
  if (main === 'bin/game.js' || main.endsWith('/game.js') || main === 'game.js') {
    throw new Error(
      `SDK6_UNSUPPORTED: "${label}" looks like a classic SDK6/Builder scene (${main || 'bin/game.js'}). This client only runs SDK7 scenes.`
    )
  }
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
    commsAdapterHint: about.commsAdapterHint,
    commsEnabled: about.commsEnabled
  }
}

async function fetchWorldEntity(
  worldName: string,
  customServer?: string | null
): Promise<{
  entity: Record<string, unknown>
  skybox?: { textures?: string[] }
  realm: RealmEndpoints
  contentServerBase: string
  contentsRoot: string
} | null> {
  const contentServerBase = worldsContentBase(customServer)
  const about = await fetchWorldRealmAbout(worldName, contentServerBase).catch(() => null)
  if (!about) return null

  const aboutRes = await fetch(worldsAboutUrl(contentServerBase, worldName), {
    headers: { Accept: 'application/json' }
  })
  if (!aboutRes.ok) return null

  const aboutJson = (await aboutRes.json()) as {
    configurations?: { scenesUrn?: string[]; skybox?: { textures?: string[] } }
  }
  const urn = aboutJson.configurations?.scenesUrn?.[0]
  if (typeof urn !== 'string') return null

  const entityId = entityIdFromScenesUrn(urn)
  if (!entityId) return null

  // Prefer baseUrl on scenesUrn when present (official about often embeds it).
  const urnContentsRoot = contentBaseFromScenesUrn(urn)
  const contentsRoot = urnContentsRoot ?? `${contentServerBase}/contents`

  const entityRes = await fetch(`${contentsRoot.replace(/\/+$/, '')}/${encodeURIComponent(entityId)}`, {
    headers: { Accept: 'application/json' }
  })
  if (!entityRes.ok) return null

  const entity = (await entityRes.json()) as Record<string, unknown>
  return {
    entity: { ...entity, id: entityId },
    skybox: aboutJson.configurations?.skybox,
    realm: realmFromAbout(about),
    contentServerBase,
    contentsRoot: contentsRoot.replace(/\/+$/, '')
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

const FALLBACK_GENESIS_REALM: RealmEndpoints = {
  realmName: 'main',
  networkId: 1,
  contentUrl: 'https://peer.decentraland.org',
  lambdasUrl: 'https://peer.decentraland.org/lambdas',
  commsEnabled: true
}

/**
 * Classic foundation open-road / SDK6 tile — cannot run as primary, but should not
 * hard-fail Jump In. AOI road layer still draws the GLB; primary is synthetic empty.
 */
export function isOpenRoadOrNonRunnableSdk6Entity(entity: Record<string, unknown>): boolean {
  const meta =
    entity.metadata && typeof entity.metadata === 'object'
      ? (entity.metadata as Record<string, unknown>)
      : {}
  const display =
    meta.display && typeof meta.display === 'object'
      ? (meta.display as Record<string, unknown>)
      : {}
  const title = typeof display.title === 'string' ? display.title : ''
  const main = typeof meta.main === 'string' ? meta.main.trim().toLowerCase() : ''
  const rv = meta.runtimeVersion
  const rvStr = rv === undefined || rv === null ? '' : String(rv).trim()

  if (rvStr === '7' || rvStr.startsWith('7.')) return false
  if (rvStr === '6' || rvStr.startsWith('6.')) return true
  if (/^Road at /i.test(title)) return true

  if (main === 'game.js' || main.endsWith('/game.js') || main === 'bin/game.js') {
    const content = Array.isArray(entity.content) ? entity.content : []
    const hasRoadGlb = content.some((row) => {
      if (!row || typeof row !== 'object') return false
      const file =
        typeof (row as { file?: string }).file === 'string' ? (row as { file: string }).file : ''
      const base = file.split('/').pop() ?? file
      return /^(OpenRoad_|OpenFork_|Road_|DeadEnd_|Fork_|Corner_|EmptyFork_)/i.test(base)
    })
    if (hasRoadGlb || /road|openroad|openfork|tram/i.test(title)) return true
    // Classic Builder SDK6 without runtimeVersion 7
    return true
  }
  return false
}

/**
 * Synthetic 1×1 genesis primary — empty land or non-runnable SDK6 (roads).
 * AOI still supplies road GLBs / blank floor. Never throws.
 */
async function resolveEmptyCoordsScene(
  x: number,
  y: number,
  opts?: { title?: string; reason?: string }
): Promise<ResolvedScene> {
  const pointer = `${x},${y}`
  let realm: RealmEndpoints = FALLBACK_GENESIS_REALM
  try {
    const about = await fetchCatalystRealmAbout()
    realm = realmFromAbout(about)
  } catch (err) {
    console.warn('[resolve] empty parcel — realm about failed, using peer.decentraland.org', err)
  }
  const contentUrl = catalystRootFromContentUrl(realm.contentUrl)
  // Live feet coords live on the location card / URL — don't bake base into the title.
  const title = opts?.title?.trim() || 'Empty land'
  const metadata: SceneMetadata = {
    display: { title },
    scene: { parcels: [pointer], base: pointer },
    // genesis sky; ground + trees / roads come from AoiVisualLayer
    environment: 'genesis'
  }
  const resolvedEnv = resolveSceneEnvironment(metadata, { kind: 'coords', x, y })
  console.info(
    `[resolve] synthetic primary ${pointer} — “${title}”${opts?.reason ? ` (${opts.reason})` : ''}`
  )
  return {
    title,
    parcels: [pointer],
    baseParcel: pointer,
    spawn: { x: 8, y: 0, z: 8, fromSpawnPoints: false },
    metadata,
    landscapeEnvironment: resolvedEnv.landscapeEnvironment,
    skyLighting: resolvedEnv.skyLighting,
    content: [],
    contentsBaseUrl: contentUrl,
    assetUrl: (hash) => catalystContentAssetUrl(realm.contentUrl, hash),
    source: { kind: 'coords', x, y },
    entityId: null,
    mainEntry: null,
    commsPointer: pointer,
    browserChatEnabled: resolveBrowserChatEnabled(metadata),
    nameTagsVisible: resolveNameTagsVisible(metadata),
    portableExperiencesPolicy: resolvePortableExperiencesPolicy(metadata),
    realm
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

  // Official skyboxConfig: fixedTime only. Client lighting lives on `environment`.
  const finiteSlider = (v: unknown): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const envCfg =
    metadata.environment && typeof metadata.environment === 'object'
      ? metadata.environment
      : undefined
  const environmentLighting = {
    sunLight: finiteSlider(envCfg?.sunLight),
    exposure: finiteSlider(envCfg?.exposure),
    moonLight: finiteSlider(envCfg?.moonLight),
    moonExposure: finiteSlider(envCfg?.moonExposure)
  }
  const hasEnvironmentLighting = Object.values(environmentLighting).some((v) => v !== undefined)

  const skybox =
    typeof skyboxConfig?.fixedTime === 'number' || textures.length || hasEnvironmentLighting
      ? {
          fixedTime: skyboxConfig?.fixedTime,
          textures: textures.length ? textures : undefined,
          ...environmentLighting
        }
      : undefined

  const resolvedEnv = resolveSceneEnvironment(metadata, opts.source)
  const mainEntry = findMainEntry(content, metadata)
  const title = display?.title ?? opts.title
  assertSdk7CompatibleScene(metadata, mainEntry, title)

  return {
    title,
    parcels,
    baseParcel: base,
    spawn: pickSceneSpawn(metadata),
    metadata,
    landscapeEnvironment: resolvedEnv.landscapeEnvironment,
    skyLighting: resolvedEnv.skyLighting,
    content,
    contentsBaseUrl: opts.contentsBaseUrl,
    assetUrl: opts.assetUrl,
    source: opts.source,
    entityId,
    mainEntry,
    skybox,
    commsPointer: opts.commsPointer,
    browserChatEnabled: resolveBrowserChatEnabled(metadata),
    nameTagsVisible: resolveNameTagsVisible(metadata),
    portableExperiencesPolicy: resolvePortableExperiencesPolicy(metadata),
    realm: opts.realm
  }
}

function displayTitleFromEntity(entity: Record<string, unknown>): string | null {
  const metadata = (entity.metadata ?? {}) as SceneMetadata
  const title = metadata.display?.title
  if (typeof title === 'string' && title.trim()) return title.trim()
  return null
}

/** Deployed scene `scene.json` display title — canonical creator metadata. */
export async function fetchDeployedSceneDisplayTitle(
  target: Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }>
): Promise<string | null> {
  if (target.kind === 'coords') {
    const result = await fetchParcelEntity(target.x, target.y)
    return result ? displayTitleFromEntity(result.entity) : null
  }

  const customServer = target.customServer
  for (const pointer of worldPointersForTarget(target)) {
    const result = await fetchWorldEntity(pointer, customServer)
    if (!result) continue
    const title = displayTitleFromEntity(result.entity)
    if (title) return title
  }
  return null
}

export type WorldDeployDisplayMeta = {
  title: string | null
  description: string
  imageUrl: string | null
  contentServerBase: string
}

/**
 * Title / description / thumbnail from the worlds content server entity
 * (not Places API). Used for custom-realm landing so we never show DCL catalog data.
 */
export async function fetchWorldDeployDisplayMeta(
  worldName: string,
  customServer?: string | null
): Promise<WorldDeployDisplayMeta | null> {
  const result = await fetchWorldEntity(worldName, customServer)
  if (!result) return null
  const metadata = (result.entity.metadata ?? {}) as Record<string, unknown>
  const display =
    metadata.display && typeof metadata.display === 'object'
      ? (metadata.display as Record<string, unknown>)
      : {}
  const title = displayTitleFromEntity(result.entity)
  const description =
    (typeof display.description === 'string' && display.description.trim()) ||
    (typeof metadata.description === 'string' && metadata.description.trim()) ||
    ''

  let imageUrl: string | null = null
  const thumb = typeof display.navmapThumbnail === 'string' ? display.navmapThumbnail.trim() : ''
  if (thumb) {
    if (/^https?:\/\//i.test(thumb)) {
      imageUrl = thumb
    } else {
      const content = Array.isArray(result.entity.content) ? result.entity.content : []
      for (const row of content) {
        if (!row || typeof row !== 'object') continue
        const file = typeof (row as { file?: string }).file === 'string' ? (row as { file: string }).file : ''
        const hash = typeof (row as { hash?: string }).hash === 'string' ? (row as { hash: string }).hash : ''
        if (!file || !hash) continue
        if (file === thumb || file.endsWith(`/${thumb}`) || file.endsWith(thumb)) {
          imageUrl = `${result.contentsRoot}/${encodeURIComponent(hash)}`
          break
        }
      }
    }
  }

  return {
    title,
    description,
    imageUrl,
    contentServerBase: result.contentServerBase
  }
}

export async function resolveSceneFromRoute(target: RouteTarget): Promise<ResolvedScene> {
  if (target.kind === 'editor') {
    throw new Error('Editor route does not resolve a network scene — use EditorApp')
  }

  if (target.kind === 'events') {
    throw new Error('Events route does not resolve a network scene')
  }

  if (target.kind === 'communities') {
    throw new Error('Communities route does not resolve a network scene')
  }

  if (target.kind === 'map') {
    throw new Error('Map route does not resolve a network scene')
  }

  if (target.kind === 'profile') {
    throw new Error('Profile route does not resolve a network scene')
  }

  if (target.kind === 'lootbag') {
    throw new Error('Loot Bag route does not resolve a network scene')
  }

  if (target.kind === 'marketplace') {
    throw new Error('Marketplace route does not resolve a network scene')
  }

  if (target.kind === 'blank') {
    const metadata = { ...BLANK_SCENE_TEMPLATE.metadata, environment: 'none' as const }
    const resolvedEnv = resolveSceneEnvironment(metadata, { kind: 'blank' })
    return {
      ...BLANK_SCENE_TEMPLATE,
      metadata,
      landscapeEnvironment: resolvedEnv.landscapeEnvironment,
      skyLighting: resolvedEnv.skyLighting,
      browserChatEnabled: resolveBrowserChatEnabled(metadata),
      nameTagsVisible: resolveNameTagsVisible(metadata),
      portableExperiencesPolicy: resolvePortableExperiencesPolicy(metadata)
    }
  }

  if (target.kind === 'coords') {
    const result = await fetchParcelEntity(target.x, target.y)
    const pointer = `${target.x},${target.y}`
    if (result) {
      // Open roads / classic SDK6 — enter as synthetic empty primary; AOI draws road GLBs.
      if (isOpenRoadOrNonRunnableSdk6Entity(result.entity)) {
        const meta = (result.entity.metadata ?? {}) as SceneMetadata
        const roadTitle = meta.display?.title?.trim()
        return resolveEmptyCoordsScene(target.x, target.y, {
          title: roadTitle || `Open road ${pointer}`,
          reason: 'open-road/SDK6 — not runnable as primary'
        })
      }
      return resolvedFromEntity(result.entity, {
        title: pointer,
        commsPointer: pointer,
        realm: result.realm,
        source: { kind: 'coords', x: target.x, y: target.y },
        contentsBaseUrl: catalystRootFromContentUrl(result.realm.contentUrl),
        assetUrl: (hash) => catalystContentAssetUrl(result.realm.contentUrl, hash)
      })
    }
    // True empty parcel — synthetic 1×1 so AOI blank + scatter + open walk can run.
    return resolveEmptyCoordsScene(target.x, target.y)
  }

  const tried: string[] = []
  const customServer = target.customServer
  for (const pointer of worldPointersForTarget(target)) {
    tried.push(pointer)
    const result = await fetchWorldEntity(pointer, customServer)
    if (!result) continue

    const entityId = typeof result.entity.id === 'string' ? result.entity.id : null
    if (!entityId) continue

    const contentsRoot = result.contentsRoot
    return resolvedFromEntity(result.entity, {
      title: pointer,
      commsPointer: pointer.toLowerCase(),
      realm: result.realm,
      source: {
        kind: 'world',
        worldName: pointer,
        entityId,
        ...(customServer ? { customServer: result.contentServerBase } : {})
      },
      contentsBaseUrl: result.contentServerBase,
      assetUrl: (hash) => `${contentsRoot}/${encodeURIComponent(hash)}`,
      aboutSkybox: result.skybox
    })
  }

  const serverLabel = customServer ? worldsContentBase(customServer) : 'worlds-content-server'
  throw new Error(`World not found (${tried.join(' → ')}). Check the name on ${serverLabel}.`)
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
