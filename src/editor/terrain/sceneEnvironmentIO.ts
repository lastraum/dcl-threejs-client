import type {
  SceneDesertConfig,
  SceneEnvironmentConfig,
  SceneEnvironmentKind,
  SceneForestConfig,
  SceneLandConfig,
  SceneMetadata,
  SceneMountainsConfig,
  SceneSpaceConfig,
  SceneWaterConfig
} from '../../dcl/content/types'
import { LANDSCAPE_ENVIRONMENTS } from '../../dcl/landscape/EnvironmentCatalog'
import { readFileText, writeFileBytes } from '../localScene/localFileSystem'
import type { ProjectRoot } from '../localScene/projectRoot'

const SCENE_JSON = 'scene.json'

const KINDS = Object.keys(LANDSCAPE_ENVIRONMENTS) as SceneEnvironmentKind[]

export function isSceneEnvironmentKind(raw: string): raw is SceneEnvironmentKind {
  return (KINDS as string[]).includes(raw)
}

export function environmentKinds(): readonly SceneEnvironmentKind[] {
  return KINDS
}

/** Normalize scene.json environment to object form (string → { kind }). */
export function normalizeEnvironment(
  env: SceneMetadata['environment']
): SceneEnvironmentConfig {
  if (!env) return { kind: 'none' }
  if (typeof env === 'string') {
    const kind = isSceneEnvironmentKind(env.trim().toLowerCase())
      ? (env.trim().toLowerCase() as SceneEnvironmentKind)
      : 'none'
    return { kind }
  }
  return { ...env }
}

export function readEnvironmentKind(env: SceneEnvironmentConfig): SceneEnvironmentKind {
  if (env.kind && isSceneEnvironmentKind(String(env.kind))) return env.kind
  return 'none'
}

/** Load environment object from project scene.json. */
export async function loadProjectEnvironment(
  root: ProjectRoot
): Promise<SceneEnvironmentConfig> {
  const text = await readFileText(root, SCENE_JSON)
  if (!text) return { kind: 'none' }
  try {
    const meta = JSON.parse(text) as SceneMetadata
    return normalizeEnvironment(meta.environment)
  } catch {
    return { kind: 'none' }
  }
}

/**
 * Merge patch into scene.json `environment` (object form).
 * Preserves all other scene.json fields.
 * Pass `replaceWater: true` with `water` to fully replace the water block (FFTOCEAN reset).
 * Pass `replaceSpace` / `replaceDesert` / `replaceMountains` to fully replace those blocks.
 */
export async function patchProjectEnvironment(
  root: ProjectRoot,
  patch: Partial<SceneEnvironmentConfig> & {
    water?: SceneWaterConfig | null
    replaceWater?: boolean
    space?: SceneSpaceConfig | null
    replaceSpace?: boolean
    desert?: SceneDesertConfig | null
    replaceDesert?: boolean
    land?: SceneLandConfig | null
    replaceLand?: boolean
    forest?: SceneForestConfig | null
    replaceForest?: boolean
    mountains?: SceneMountainsConfig | null
    replaceMountains?: boolean
  }
): Promise<SceneEnvironmentConfig> {
  const text = await readFileText(root, SCENE_JSON)
  if (!text) throw new Error('scene.json not found')
  const meta = JSON.parse(text) as SceneMetadata
  const current = normalizeEnvironment(meta.environment)

  const {
    replaceWater,
    replaceSpace,
    replaceDesert,
    replaceLand,
    replaceForest,
    replaceMountains,
    ...envPatch
  } = patch
  const next: SceneEnvironmentConfig = { ...current, ...envPatch }
  // strip control flags if they leaked into env shape
  delete (next as { replaceWater?: boolean }).replaceWater
  delete (next as { replaceSpace?: boolean }).replaceSpace
  delete (next as { replaceDesert?: boolean }).replaceDesert
  delete (next as { replaceLand?: boolean }).replaceLand
  delete (next as { replaceForest?: boolean }).replaceForest
  delete (next as { replaceMountains?: boolean }).replaceMountains

  if (patch.water === null) {
    delete next.water
  } else if (patch.water && typeof patch.water === 'object') {
    next.water = replaceWater
      ? { ...patch.water }
      : { ...(current.water ?? {}), ...patch.water }
  }

  if (patch.space === null) {
    delete next.space
  } else if (patch.space && typeof patch.space === 'object') {
    next.space = replaceSpace
      ? { ...patch.space }
      : { ...(current.space ?? {}), ...patch.space }
  }

  if (patch.desert === null) {
    delete next.desert
  } else if (patch.desert && typeof patch.desert === 'object') {
    next.desert = replaceDesert
      ? { ...patch.desert }
      : { ...(current.desert ?? {}), ...patch.desert }
  }

  if (patch.land === null) {
    delete next.land
  } else if (patch.land && typeof patch.land === 'object') {
    next.land = replaceLand
      ? { ...patch.land }
      : { ...(current.land ?? {}), ...patch.land }
  }

  if (patch.forest === null) {
    delete next.forest
  } else if (patch.forest && typeof patch.forest === 'object') {
    next.forest = replaceForest
      ? { ...patch.forest }
      : {
          ...(current.forest ?? {}),
          ...patch.forest,
          // Array fields replace (not shallow-merge slots).
          ...(patch.forest.treeDensity ? { treeDensity: [...patch.forest.treeDensity] } : {}),
          ...(patch.forest.rockDensity ? { rockDensity: [...patch.forest.rockDensity] } : {})
        }
  }

  if (patch.mountains === null) {
    delete next.mountains
  } else if (patch.mountains && typeof patch.mountains === 'object') {
    next.mountains = replaceMountains
      ? { ...patch.mountains }
      : { ...(current.mountains ?? {}), ...patch.mountains }
  }

  meta.environment = next
  const out = `${JSON.stringify(meta, null, 2)}\n`
  await writeFileBytes(root, SCENE_JSON, new TextEncoder().encode(out))
  return next
}

export function waterShowsOceanUi(kind: SceneEnvironmentKind): boolean {
  return kind === 'island' || kind === 'water' || kind === 'mountains'
}
