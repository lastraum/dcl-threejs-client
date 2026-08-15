import type { ContentFile, RealmEndpoints, ResolvedScene, SceneMetadata } from './types'
import { pickSceneSpawn } from './pickSceneSpawn'
import { layoutFromSceneMetadata } from './sceneLayout'
import { resolveBrowserChatEnabled } from './resolveBrowserChat'
import { resolveNameTagsVisible } from './resolveNameTags'
import { resolvePortableExperiencesPolicy } from '../multiScene/resolvePortableExperiences'
import { resolveSceneEnvironment } from '../landscape/resolveLandscapeEnvironment'

export function parseContent(raw: unknown): ContentFile[] {
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

export function findMainEntry(content: ContentFile[], metadata: SceneMetadata): string | null {
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

export function resolvedFromEntity(
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
