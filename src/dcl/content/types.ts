export type ContentFile = { file: string; hash: string }

export type SceneSource =
  | { kind: 'blank' }
  | { kind: 'world'; worldName: string; entityId: string }
  | { kind: 'coords'; x: number; y: number }
  | { kind: 'local'; projectId: string }

export type SceneLayout = {
  parcels: string[]
  base: string
}

export type SpawnPoint = {
  name: string
  default?: boolean
  position: { x: number | number[]; y: number | number[]; z: number | number[] }
  cameraTarget?: { x: number; y: number; z: number }
}

export type SceneSpawn = {
  x: number
  y: number
  z: number
  cameraTarget?: { x: number; y: number; z: number }
  /** True when resolved from scene.json `spawnPoints` (use Y as-authored). */
  fromSpawnPoints?: boolean
  /** Chosen entry name when `fromSpawnPoints` — boot log only. */
  spawnPointName?: string
}

/** scene.json `environment` — biome for client landscape (worlds default island; parcels default genesis). */
export type SceneEnvironmentKind =
  | 'none'
  | 'genesis'
  | 'island'
  | 'water'
  | 'space'
  | 'mountains'
  | 'desert'
  | 'land'
  | 'forest'

/**
 * `scene.json` → `environment` object — **ThreejsClient-only** landscape + celestial defaults.
 * Not part of official DCL SDK / Unity Explorer metadata (they ignore unknown fields).
 * Official time pin remains `skyboxConfig.fixedTime` only.
 */
export type SceneEnvironmentConfig = {
  /** Landscape biome (`none`, `genesis`, `island`, …). String form `"environment": "none"` sets kind only. */
  kind?: SceneEnvironmentKind
  /**
   * Full skylight-off while the sun period is active: no sun disc/directional,
   * hemi/equator zeroed, void-style exposure (same as URL `?disableSun=1`).
   */
  disableSun?: boolean
  /**
   * Full skylight-off while the moon period is active: no moon disc/directional,
   * hemi/equator zeroed — not “moon disc only” (same as URL `?disableMoon=1`).
   */
  disableMoon?: boolean
  /** Directional sun + day hemi (0–100, Skybox-overrides panel scale). Creator per-scene default. */
  sunLight?: number
  /** ACES exposure multiplier during day (0–100). */
  exposure?: number
  /** Directional moon + night hemi (0–100). */
  moonLight?: number
  /** ACES exposure multiplier during night (0–100). */
  moonExposure?: number
}

export type SceneSkyLighting = {
  disableSun: boolean
  disableMoon: boolean
}

export type SceneFeatureToggle = 'enabled' | 'disabled' | 'hideUi'

export type SceneFeatureToggles = {
  voiceChat?: SceneFeatureToggle
  portableExperiences?: SceneFeatureToggle
  browserChat?: SceneFeatureToggle
}

export type SceneBrowserChatConfig = {
  enabled?: boolean
  disabled?: boolean
}

export type ScenePolicy = {
  /** Catalyst entity metadata — wallet addresses denied entry before gatekeeper. */
  blacklist?: string[]
}

/**
 * Official DCL `scene.json` → `skyboxConfig` (SDK / Explorer).
 * Only `fixedTime` is documented — do not put client-only lighting here.
 */
export type SceneSkyboxConfigMetadata = {
  /** Seconds since midnight (0–86400) — pins skybox time like Unity Explorer. */
  fixedTime?: number
}

export type SceneMetadata = {
  display?: { title?: string; description?: string; skybox?: string; skyboxTexture?: string }
  policy?: ScenePolicy
  scene?: SceneLayout
  spawnPoints?: SpawnPoint[]
  main?: string
  /** Official: fixed time of day only. */
  skyboxConfig?: SceneSkyboxConfigMetadata
  /**
   * ThreejsClient landscape + celestial defaults (kind, disable*, light sliders).
   * String form sets biome only; object form may include lighting.
   */
  environment?: SceneEnvironmentKind | SceneEnvironmentConfig
  featureToggles?: SceneFeatureToggles
  /** `featureToggles.browserChat` alias — `"disabled"` or `{ "enabled": false }`. */
  browserChat?: SceneFeatureToggle | SceneBrowserChatConfig
}

export type SkyboxConfig = {
  /** Seconds since midnight (0–86400). From scene.json or SkyboxTime ECS. */
  fixedTime?: number
  /** Custom cubemap face hashes/URLs from world `/about`. */
  textures?: string[]
  /**
   * Creator sun/moon defaults resolved from `scene.json` `environment` (0–100 panel scale).
   * Not official SDK fields — carried on ResolvedScene for EnvironmentSystem only.
   */
  sunLight?: number
  exposure?: number
  moonLight?: number
  moonExposure?: number
}

/** Catalyst / worlds realm endpoints from `/about`. */
export type RealmEndpoints = {
  realmName: string
  networkId: number
  contentUrl: string
  lambdasUrl: string
  commsAdapterHint?: string
}

export type ResolvedScene = {
  title: string
  parcels: string[]
  baseParcel: string
  spawn: SceneSpawn
  metadata: SceneMetadata
  /** Resolved landscape biome (scene.json + URL override). */
  landscapeEnvironment: SceneEnvironmentKind
  /** Celestial disable flags from `environment` (+ URL overrides). */
  skyLighting: SceneSkyLighting
  content: ContentFile[]
  contentsBaseUrl: string
  assetUrl: (hash: string) => string
  source: SceneSource
  entityId: string | null
  mainEntry: string | null
  skybox?: SkyboxConfig
  /** Base parcel or world name used for comms-gatekeeper. */
  commsPointer: string
  /** scene.json `featureToggles.browserChat` (+ `?browserChat=` URL override). */
  browserChatEnabled: boolean
  realm: RealmEndpoints
}

export const PARCEL_SIZE = 16

export const BLANK_SCENE_TEMPLATE: ResolvedScene = {
  title: 'Blank Scene (1×1 template)',
  parcels: ['0,0'],
  baseParcel: '0,0',
  spawn: { x: 8, y: 0, z: 8 },
  metadata: { environment: 'none' },
  landscapeEnvironment: 'genesis',
  skyLighting: { disableSun: false, disableMoon: false },
  content: [],
  contentsBaseUrl: 'https://peer.decentraland.org',
  assetUrl: (hash) => `https://peer.decentraland.org/content/contents/${encodeURIComponent(hash)}`,
  source: { kind: 'blank' },
  entityId: null,
  mainEntry: null,
  commsPointer: '0,0',
  browserChatEnabled: true,
  realm: {
    realmName: 'main',
    networkId: 1,
    contentUrl: 'https://peer.decentraland.org',
    lambdasUrl: 'https://peer.decentraland.org/lambdas'
  }
}
