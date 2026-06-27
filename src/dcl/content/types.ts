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

/** scene.json `environment` — biome for client landscape (worlds default island; parcel scenes default none). */
export type SceneEnvironmentKind =
  | 'none'
  | 'island'
  | 'water'
  | 'space'
  | 'mountains'
  | 'desert'
  | 'land'
  | 'forest'

/** `scene.json` → `environment` object — biome + optional celestial lighting toggles. */
export type SceneEnvironmentConfig = {
  kind?: SceneEnvironmentKind
  /** No directional sun light or visible sun disc — scene relies on ECS / local lights. */
  disableSun?: boolean
  /** No directional moon light or visible moon disc. */
  disableMoon?: boolean
}

export type SceneSkyLighting = {
  disableSun: boolean
  disableMoon: boolean
}

export type SceneMetadata = {
  display?: { title?: string; description?: string; skybox?: string; skyboxTexture?: string }
  scene?: SceneLayout
  spawnPoints?: SpawnPoint[]
  main?: string
  skyboxConfig?: { fixedTime?: number }
  /** Biome id string or object — opt-in on parcel scenes; worlds fall back to island when omitted. */
  environment?: SceneEnvironmentKind | SceneEnvironmentConfig
}

export type SkyboxConfig = {
  /** Seconds since midnight (0–86400). From scene.json or SkyboxTime ECS. */
  fixedTime?: number
  /** Custom cubemap face hashes/URLs from world `/about`. */
  textures?: string[]
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
  /** Celestial lights from `environment.disableSun` / `disableMoon` (+ dev URL overrides). */
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
  realm: RealmEndpoints
}

export const PARCEL_SIZE = 16

export const BLANK_SCENE_TEMPLATE: ResolvedScene = {
  title: 'Blank Scene (1×1 template)',
  parcels: ['0,0'],
  baseParcel: '0,0',
  spawn: { x: 8, y: 0, z: 8 },
  metadata: { environment: 'none' },
  landscapeEnvironment: 'none',
  skyLighting: { disableSun: false, disableMoon: false },
  content: [],
  contentsBaseUrl: 'https://peer.decentraland.org',
  assetUrl: (hash) => `https://peer.decentraland.org/content/contents/${encodeURIComponent(hash)}`,
  source: { kind: 'blank' },
  entityId: null,
  mainEntry: null,
  commsPointer: '0,0',
  realm: {
    realmName: 'main',
    networkId: 1,
    contentUrl: 'https://peer.decentraland.org',
    lambdasUrl: 'https://peer.decentraland.org/lambdas'
  }
}
