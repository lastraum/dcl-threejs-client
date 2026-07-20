const STORAGE_KEY = 'dcl-render-quality'

export enum RenderQualityTier {
  Low = 'low',
  Medium = 'medium',
  High = 'high',
  Ultra = 'ultra'
}

export type GraphicsPreset = 'low' | 'medium' | 'high' | 'ultra' | 'custom'
export type ShadowQuality = 'off' | 'low' | 'medium' | 'high' | 'ultra'
/** 0 = uncapped (display refresh). */
export type FpsLimitOption = 30 | 60 | 120 | 0
/** Multisample AA sample count (0 = off). WebGL2 RT path. */
export type MsaaSamples = 0 | 2 | 4 | 8

export type RenderQualityOptions = {
  tier: RenderQualityTier
  preset: GraphicsPreset
  shadowQuality: ShadowQuality
  sceneLightsEnabled: boolean
  maxSceneLights: number
  /** Percent of devicePixelRatio (50–200). */
  resolutionScale: number
  fpsLimit: FpsLimitOption
  /** MSAA samples for the main color buffer (0/2/4/8). Skipped when bloom is on. */
  msaaSamples: MsaaSamples
  /**
   * Prefer display-aligned pacing when FPS is Max.
   * Browsers still composite with the display; Off does not enable free-run tearing.
   */
  vsync: boolean
  /** UnrealBloomPass full-screen glow (muzzle / neon / sky highlights). */
  bloomEnabled: boolean
  /**
   * HalfFloat composer color buffer — keeps bright emissives above 1.0 for bloom.
   * Off = 8-bit path (cheaper, more clip).
   */
  hdrEnabled: boolean
  /**
   * Outer AOI radius (meters) for secondary **visual** loads (main.composite GLBs,
   * roads, empty layer). 0 = primary only. Independent of graphics presets.
   * Script warming uses a separate fixed inner radius (see SCENE_SCRIPT_WARM_RADIUS_M).
   */
  sceneLoadRadiusM: number
}

/** Min/max for Preferences → Scene Distance (AOI neighbor load radius). */
export const SCENE_LOAD_RADIUS_MIN_M = 0
export const SCENE_LOAD_RADIUS_MAX_M = 200
/** Default AOI — ~6 parcels; used until multi-scene secondary loader exists. */
export const SCENE_LOAD_RADIUS_DEFAULT_M = 100

/** Max ECS LightSource lights active at once (nearest to avatar) — preset defaults. */
export const LIGHT_LIMITS: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 4,
  [RenderQualityTier.Medium]: 6,
  [RenderQualityTier.High]: 10,
  [RenderQualityTier.Ultra]: 16
}

/** Max simultaneous VideoPlayer decoders (DCL Explorer parity). */
export const VIDEO_PLAYER_LIMITS: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 1,
  [RenderQualityTier.Medium]: 5,
  [RenderQualityTier.High]: 10,
  [RenderQualityTier.Ultra]: 10
}

export const MAX_SHADOW_SPOT_LIGHTS = 3
export const LIGHT_CULL_DISTANCE_M = 40

export const RESOLUTION_SCALE_MIN = 50
export const RESOLUTION_SCALE_MAX = 200
export const MAX_SCENE_LIGHTS_CAP = 20

/** Spot / directional shadow map resolution by shadow quality (not overall tier). */
export const SHADOW_MAP_SIZE: Record<Exclude<ShadowQuality, 'off'>, number> = {
  low: 512,
  medium: 1024,
  high: 1024,
  ultra: 2048
}

/** Renderer exposure with ACESFilmic tone mapping — tier-tuned (sky disc is toneMapped: false). */
export const TONE_MAPPING_EXPOSURE: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 1.0,
  [RenderQualityTier.Medium]: 1.05,
  [RenderQualityTier.High]: 1.08,
  [RenderQualityTier.Ultra]: 1.1
}

type PresetId = Exclude<GraphicsPreset, 'custom'>

/** Graphics preset fields — AOI radius is user-owned, not preset-bundled. */
type PresetBundle = Omit<RenderQualityOptions, 'preset' | 'sceneLoadRadiusM'>

const PRESET_BUNDLES: Record<PresetId, PresetBundle> = {
  low: {
    tier: RenderQualityTier.Low,
    shadowQuality: 'low',
    sceneLightsEnabled: true,
    maxSceneLights: LIGHT_LIMITS[RenderQualityTier.Low],
    resolutionScale: 75,
    fpsLimit: 30,
    msaaSamples: 0,
    vsync: true,
    bloomEnabled: false,
    hdrEnabled: false
  },
  medium: {
    tier: RenderQualityTier.Medium,
    shadowQuality: 'medium',
    sceneLightsEnabled: true,
    maxSceneLights: LIGHT_LIMITS[RenderQualityTier.Medium],
    resolutionScale: 100,
    fpsLimit: 60,
    // 4× MSAA on plaza-scale (1.5M+ tris) was a silent FPS tax; high keeps 4.
    msaaSamples: 0,
    vsync: true,
    // Off by default — selective bloom full-scene material swap kills Genesis.
    // High/ultra keep bloom for neon/muzzle; auto-skipped when mesh count is huge.
    bloomEnabled: false,
    hdrEnabled: false
  },
  high: {
    tier: RenderQualityTier.High,
    shadowQuality: 'high',
    sceneLightsEnabled: true,
    maxSceneLights: LIGHT_LIMITS[RenderQualityTier.High],
    resolutionScale: 100,
    fpsLimit: 60,
    msaaSamples: 4,
    vsync: true,
    bloomEnabled: true,
    hdrEnabled: true
  },
  ultra: {
    tier: RenderQualityTier.Ultra,
    shadowQuality: 'ultra',
    sceneLightsEnabled: true,
    maxSceneLights: LIGHT_LIMITS[RenderQualityTier.Ultra],
    resolutionScale: 125,
    fpsLimit: 0,
    msaaSamples: 8,
    vsync: true,
    bloomEnabled: true,
    hdrEnabled: true
  }
}

const DEFAULT_OPTIONS: RenderQualityOptions = {
  preset: 'medium',
  ...PRESET_BUNDLES.medium,
  sceneLoadRadiusM: SCENE_LOAD_RADIUS_DEFAULT_M
}

type Listener = (options: RenderQualityOptions) => void

function clampResolutionScale(value: number): number {
  return Math.round(Math.max(RESOLUTION_SCALE_MIN, Math.min(RESOLUTION_SCALE_MAX, value)))
}

function clampMaxLights(value: number): number {
  return Math.round(Math.max(0, Math.min(MAX_SCENE_LIGHTS_CAP, value)))
}

function clampSceneLoadRadiusM(value: number): number {
  if (!Number.isFinite(value)) return SCENE_LOAD_RADIUS_DEFAULT_M
  return Math.round(
    Math.max(SCENE_LOAD_RADIUS_MIN_M, Math.min(SCENE_LOAD_RADIUS_MAX_M, value))
  )
}

function isTier(v: unknown): v is RenderQualityTier {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'ultra'
}

function isShadowQuality(v: unknown): v is ShadowQuality {
  return v === 'off' || v === 'low' || v === 'medium' || v === 'high' || v === 'ultra'
}

function isFpsLimit(v: unknown): v is FpsLimitOption {
  return v === 0 || v === 30 || v === 60 || v === 120
}

function isMsaaSamples(v: unknown): v is MsaaSamples {
  return v === 0 || v === 2 || v === 4 || v === 8
}

function isPreset(v: unknown): v is GraphicsPreset {
  return v === 'low' || v === 'medium' || v === 'high' || v === 'ultra' || v === 'custom'
}

function normalizeFpsLimit(v: unknown): FpsLimitOption | null {
  if (typeof v === 'number' && isFpsLimit(v)) return v
  if (v === 'Max' || v === 'max' || v === 'unlimited') return 0
  if (typeof v === 'string') {
    const n = Number(v)
    if (isFpsLimit(n)) return n
  }
  return null
}

function normalizeMsaa(v: unknown): MsaaSamples | null {
  if (isMsaaSamples(v)) return v
  if (v === 'Off' || v === 'off') return 0
  if (typeof v === 'string') {
    const m = /^(\d+)x$/i.exec(v.trim())
    if (m) {
      const n = Number(m[1])
      if (isMsaaSamples(n)) return n
    }
    const n = Number(v)
    if (isMsaaSamples(n)) return n
  }
  return null
}

/** Effective WebGL pixel ratio from device DPR × resolution scale %. */
export function effectivePixelRatio(resolutionScale: number, devicePixelRatio = window.devicePixelRatio): number {
  const scale = clampResolutionScale(resolutionScale) / 100
  return Math.max(0.5, Math.min(3, devicePixelRatio * scale))
}

/** Clamp requested MSAA to GPU maxSamples (WebGL2). */
export function clampMsaaSamples(requested: MsaaSamples, maxSamples: number): MsaaSamples {
  if (requested <= 0 || maxSamples <= 0) return 0
  if (requested <= 2) return maxSamples >= 2 ? 2 : 0
  if (requested <= 4) return maxSamples >= 4 ? 4 : maxSamples >= 2 ? 2 : 0
  return maxSamples >= 8 ? 8 : maxSamples >= 4 ? 4 : maxSamples >= 2 ? 2 : 0
}

/** Client render quality — LightManager, shadows, resolution scale, FPS, MSAA (debug + Preferences). */
class RenderQualityStore {
  private options: RenderQualityOptions = { ...DEFAULT_OPTIONS }
  private readonly listeners = new Set<Listener>()
  private persisted = false

  constructor() {
    this.load()
  }

  /** True when values were loaded from localStorage (skip auto perf defaults). */
  hasPersistedSettings(): boolean {
    return this.persisted
  }

  getOptions(): RenderQualityOptions {
    return { ...this.options }
  }

  getTier(): RenderQualityTier {
    return this.options.tier
  }

  getPreset(): GraphicsPreset {
    return this.options.preset
  }

  getShadowQuality(): ShadowQuality {
    return this.options.shadowQuality
  }

  shadowsEnabled(): boolean {
    return this.options.shadowQuality !== 'off'
  }

  getShadowMapSize(): number {
    const q = this.options.shadowQuality
    if (q === 'off') return 0
    return SHADOW_MAP_SIZE[q]
  }

  sceneLightsEnabled(): boolean {
    return this.options.sceneLightsEnabled
  }

  getMaxActiveLights(): number {
    if (!this.options.sceneLightsEnabled) return 0
    return this.options.maxSceneLights
  }

  getResolutionScale(): number {
    return this.options.resolutionScale
  }

  getFpsLimit(): FpsLimitOption {
    return this.options.fpsLimit
  }

  getMsaaSamples(): MsaaSamples {
    return this.options.msaaSamples
  }

  getVsync(): boolean {
    return this.options.vsync
  }

  getBloomEnabled(): boolean {
    return this.options.bloomEnabled
  }

  getHdrEnabled(): boolean {
    return this.options.hdrEnabled
  }

  getSceneLoadRadiusM(): number {
    return this.options.sceneLoadRadiusM
  }

  /** AOI neighbor scene load radius in meters (0 = primary only). */
  setSceneLoadRadiusM(sceneLoadRadiusM: number): void {
    this.patch({ sceneLoadRadiusM: clampSceneLoadRadiusM(sceneLoadRadiusM) })
  }

  /** Apply a named preset bundle (not custom). Preserves sceneLoadRadiusM. */
  applyPreset(preset: PresetId): void {
    const bundle = PRESET_BUNDLES[preset]
    this.commit({
      preset,
      ...bundle,
      sceneLoadRadiusM: this.options.sceneLoadRadiusM
    })
  }

  setTier(tier: RenderQualityTier): void {
    this.applyPreset(tier)
  }

  setShadowQuality(shadowQuality: ShadowQuality): void {
    this.patch({ shadowQuality })
  }

  setSceneLightsEnabled(sceneLightsEnabled: boolean): void {
    this.patch({ sceneLightsEnabled })
  }

  setMaxSceneLights(maxSceneLights: number): void {
    this.patch({ maxSceneLights: clampMaxLights(maxSceneLights) })
  }

  setResolutionScale(resolutionScale: number): void {
    this.patch({ resolutionScale: clampResolutionScale(resolutionScale) })
  }

  setFpsLimit(fpsLimit: FpsLimitOption): void {
    this.patch({ fpsLimit })
  }

  setMsaaSamples(msaaSamples: MsaaSamples): void {
    this.patch({ msaaSamples })
  }

  setVsync(vsync: boolean): void {
    this.patch({ vsync })
  }

  setBloomEnabled(bloomEnabled: boolean): void {
    this.patch({ bloomEnabled })
  }

  setHdrEnabled(hdrEnabled: boolean): void {
    this.patch({ hdrEnabled })
  }

  setOptions(partial: Partial<RenderQualityOptions>): void {
    if (partial.preset && partial.preset !== 'custom' && isPreset(partial.preset)) {
      this.applyPreset(partial.preset)
      const rest = { ...partial }
      delete rest.preset
      delete rest.tier
      if (Object.keys(rest).length === 0) return
      this.patch(rest)
      return
    }
    this.patch(partial)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getOptions())
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Patch fields; mark preset Custom when diverging from a named bundle. */
  private patch(partial: Partial<RenderQualityOptions>): void {
    const next: RenderQualityOptions = { ...this.options, ...partial }
    next.maxSceneLights = clampMaxLights(next.maxSceneLights)
    next.resolutionScale = clampResolutionScale(next.resolutionScale)
    next.sceneLoadRadiusM = clampSceneLoadRadiusM(next.sceneLoadRadiusM)
    if (!isFpsLimit(next.fpsLimit)) next.fpsLimit = this.options.fpsLimit
    if (!isShadowQuality(next.shadowQuality)) next.shadowQuality = this.options.shadowQuality
    if (!isTier(next.tier)) next.tier = this.options.tier
    if (!isMsaaSamples(next.msaaSamples)) next.msaaSamples = this.options.msaaSamples
    if (typeof next.vsync !== 'boolean') next.vsync = this.options.vsync
    if (typeof next.bloomEnabled !== 'boolean') next.bloomEnabled = this.options.bloomEnabled
    if (typeof next.hdrEnabled !== 'boolean') next.hdrEnabled = this.options.hdrEnabled

    if (partial.preset === undefined || partial.preset === 'custom') {
      next.preset = this.inferPreset(next)
    }

    if (this.shallowEqual(this.options, next)) return
    this.commit(next)
  }

  private inferPreset(state: RenderQualityOptions): GraphicsPreset {
    for (const id of ['low', 'medium', 'high', 'ultra'] as const) {
      const b = PRESET_BUNDLES[id]
      if (
        state.tier === b.tier &&
        state.shadowQuality === b.shadowQuality &&
        state.sceneLightsEnabled === b.sceneLightsEnabled &&
        state.maxSceneLights === b.maxSceneLights &&
        state.resolutionScale === b.resolutionScale &&
        state.fpsLimit === b.fpsLimit &&
        state.msaaSamples === b.msaaSamples &&
        state.vsync === b.vsync &&
        state.bloomEnabled === b.bloomEnabled &&
        state.hdrEnabled === b.hdrEnabled
      ) {
        return id
      }
    }
    return 'custom'
  }

  private shallowEqual(a: RenderQualityOptions, b: RenderQualityOptions): boolean {
    return (
      a.tier === b.tier &&
      a.preset === b.preset &&
      a.shadowQuality === b.shadowQuality &&
      a.sceneLightsEnabled === b.sceneLightsEnabled &&
      a.maxSceneLights === b.maxSceneLights &&
      a.resolutionScale === b.resolutionScale &&
      a.fpsLimit === b.fpsLimit &&
      a.msaaSamples === b.msaaSamples &&
      a.vsync === b.vsync &&
      a.bloomEnabled === b.bloomEnabled &&
      a.hdrEnabled === b.hdrEnabled &&
      a.sceneLoadRadiusM === b.sceneLoadRadiusM
    )
  }

  private commit(next: RenderQualityOptions): void {
    this.options = { ...next }
    this.persist()
    this.notify()
  }

  private notify(): void {
    const snapshot = this.getOptions()
    for (const listener of this.listeners) listener(snapshot)
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.options))
      this.persisted = true
    } catch {
      /* quota or private mode */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<RenderQualityOptions>
      const next: RenderQualityOptions = { ...DEFAULT_OPTIONS }

      if (isTier(parsed.tier)) next.tier = parsed.tier
      if (isShadowQuality(parsed.shadowQuality)) next.shadowQuality = parsed.shadowQuality
      if (typeof parsed.sceneLightsEnabled === 'boolean') next.sceneLightsEnabled = parsed.sceneLightsEnabled
      if (typeof parsed.maxSceneLights === 'number') next.maxSceneLights = clampMaxLights(parsed.maxSceneLights)
      if (typeof parsed.resolutionScale === 'number') next.resolutionScale = clampResolutionScale(parsed.resolutionScale)
      const fps = normalizeFpsLimit(parsed.fpsLimit)
      if (fps !== null) next.fpsLimit = fps
      const msaa = normalizeMsaa(parsed.msaaSamples)
      if (msaa !== null) next.msaaSamples = msaa
      if (typeof parsed.vsync === 'boolean') next.vsync = parsed.vsync
      if (typeof parsed.bloomEnabled === 'boolean') next.bloomEnabled = parsed.bloomEnabled
      if (typeof parsed.hdrEnabled === 'boolean') next.hdrEnabled = parsed.hdrEnabled
      if (typeof parsed.sceneLoadRadiusM === 'number') {
        next.sceneLoadRadiusM = clampSceneLoadRadiusM(parsed.sceneLoadRadiusM)
      }

      if (isPreset(parsed.preset)) {
        next.preset = parsed.preset === 'custom' ? this.inferPreset(next) : parsed.preset
        if (next.preset !== 'custom') {
          // Only fill missing fields from bundle if user had an old partial save
          if (!isShadowQuality(parsed.shadowQuality)) {
            Object.assign(next, { ...PRESET_BUNDLES[next.preset], preset: next.preset })
          } else {
            // Merge newer fields that old saves lack
            if (msaa === null) next.msaaSamples = PRESET_BUNDLES[next.preset].msaaSamples
            if (typeof parsed.vsync !== 'boolean') next.vsync = PRESET_BUNDLES[next.preset].vsync
            if (typeof parsed.bloomEnabled !== 'boolean') {
              next.bloomEnabled = PRESET_BUNDLES[next.preset].bloomEnabled
            }
            if (typeof parsed.hdrEnabled !== 'boolean') {
              next.hdrEnabled = PRESET_BUNDLES[next.preset].hdrEnabled
            }
          }
        }
      } else if (isTier(parsed.tier)) {
        next.preset = parsed.tier
        if (!isShadowQuality(parsed.shadowQuality)) {
          Object.assign(next, { ...PRESET_BUNDLES[parsed.tier], preset: parsed.tier })
        } else {
          if (msaa === null) next.msaaSamples = PRESET_BUNDLES[parsed.tier].msaaSamples
          if (typeof parsed.vsync !== 'boolean') next.vsync = PRESET_BUNDLES[parsed.tier].vsync
          if (typeof parsed.bloomEnabled !== 'boolean') {
            next.bloomEnabled = PRESET_BUNDLES[parsed.tier].bloomEnabled
          }
          if (typeof parsed.hdrEnabled !== 'boolean') {
            next.hdrEnabled = PRESET_BUNDLES[parsed.tier].hdrEnabled
          }
        }
      }

      this.options = next
      this.persisted = true
    } catch {
      /* corrupt data */
    }
  }
}

export const renderQuality = new RenderQualityStore()
