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
/**
 * Bloom pipeline when {@link RenderQualityOptions.bloomEnabled} is on.
 * - auto: selective on high/ultra when mesh count is modest; else fast
 * - fast: 1× scene + luminance UnrealBloom (cheaper A/B)
 * - selective: 2× scene emissive extract (nicer neon, heavier)
 */
export type BloomModePreference = 'auto' | 'fast' | 'selective'

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
   * Which bloom path when bloom is on. Independent of named presets (A/B friendly).
   * Default auto preserves prior high/ultra selective behavior.
   */
  bloomMode: BloomModePreference
  /**
   * HalfFloat composer color buffer — keeps bright emissives above 1.0 for bloom.
   * Off = 8-bit path (cheaper, more clip).
   */
  hdrEnabled: boolean
  /**
   * Official DCL avatar toon banding (posterize + matte clamp). Off by default —
   * independent of graphics presets so users can opt in without Custom.
   */
  avatarToonEnabled: boolean
  /**
   * AOI warm + visual radius (meters): roads, empty layer, composites, first-frame,
   * script/manifest prefetch, and live-secondary *eligibility*. 0 = primary only.
   * Independent of graphics presets. Live workers stay tier-capped (see multiScene/caps).
   * FocusOwner (UI/audio/video/inputs) is always primary only.
   */
  sceneLoadRadiusM: number
  /**
   * When true, runtime may temporarily lower resolution scale + shadow quality
   * under sustained low FPS (see AdaptiveQualityController). User slider values
   * stay as the ceiling and are what Preferences shows.
   */
  adaptiveQualityEnabled: boolean
  /**
   * Primary scene Animator: every bound mixer advances every frame (full scene tick).
   * Off = distance sleep + fair-phase sampling (cheaper CBD). Independent of presets.
   */
  primaryFullRateAnimators: boolean
  /**
   * Local + remote avatar meshes cast into the sun/moon shadow map.
   * Independent of quality tier (quality still controls map size / soft / off).
   */
  avatarShadowsEnabled: boolean
  /**
   * Scene GLTF / MeshRenderer / NFT / props cast into the shadow map.
   * Landscape stays receive-only. Independent of avatar cast.
   */
  environmentShadowsEnabled: boolean
}

/** Min/max for Preferences → Scene Distance (AOI neighbor load radius). */
export const SCENE_LOAD_RADIUS_MIN_M = 0
export const SCENE_LOAD_RADIUS_MAX_M = 200
/**
 * Default AOI warm/visual band (~4 parcels).
 * 0 = primary only. Live workers stay adjacency-capped (see multiScene/caps).
 * Isolate single-scene CBD with `?noaoi` or slider 0.
 */
export const SCENE_LOAD_RADIUS_DEFAULT_M = 64

/** Max ECS LightSource lights active at once (nearest to avatar) — Explorer docs: 4/6/10. */
export const LIGHT_LIMITS: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 4,
  [RenderQualityTier.Medium]: 6,
  [RenderQualityTier.High]: 10,
  /** Same as High — Explorer does not grant more than 10 concurrent scene lights. */
  [RenderQualityTier.Ultra]: 10
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
/** Preferences slider ceiling — 120% is enough for sharp DPR without 2× pixel thrash. */
export const RESOLUTION_SCALE_MAX = 120
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

/** Graphics preset fields — AOI / toon / adaptive / animators / bloom mode / cast splits are user-owned. */
type PresetBundle = Omit<
  RenderQualityOptions,
  | 'preset'
  | 'sceneLoadRadiusM'
  | 'avatarToonEnabled'
  | 'adaptiveQualityEnabled'
  | 'primaryFullRateAnimators'
  | 'bloomMode'
  | 'avatarShadowsEnabled'
  | 'environmentShadowsEnabled'
>

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
    // On + fast mode (default bloomMode) — selective is opt-in only.
    bloomEnabled: true,
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
    resolutionScale: 120,
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
  // Explicit — not flipped by named presets.
  avatarToonEnabled: false,
  sceneLoadRadiusM: SCENE_LOAD_RADIUS_DEFAULT_M,
  /** On by default — steps down only under load; never raises above user settings. */
  adaptiveQualityEnabled: true,
  /** Off by default — fair sample budget. `?fullanim` or Advanced toggle for every mixer. */
  primaryFullRateAnimators: false,
  /** Split cast toggles — test avatar vs env shadow cost independently. */
  avatarShadowsEnabled: true,
  environmentShadowsEnabled: true,
  /**
   * Fast = 1× scene + luminance bloom (plaza-safe).
   * Selective is opt-in (2× extract was ~11ms on Genesis).
   * Adaptive quality may temporarily force bloom off under low FPS.
   */
  bloomMode: 'fast'
}

function isBloomModePreference(v: unknown): v is BloomModePreference {
  return v === 'auto' || v === 'fast' || v === 'selective'
}

/** Shadow ladder low → high (adaptive steps down toward index 0). */
export const SHADOW_QUALITY_LADDER: readonly ShadowQuality[] = [
  'off',
  'low',
  'medium',
  'high',
  'ultra'
] as const

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
  /**
   * Temporary runtime overrides from AdaptiveQualityController.
   * Not persisted — Preferences always shows {@link options} (user ceiling).
   */
  private adaptiveResolutionScale: number | null = null
  private adaptiveShadowQuality: ShadowQuality | null = null
  /** When true, effective bloom is forced off (user toggle still shows ON). */
  private adaptiveBloomOff = false

  constructor() {
    this.load()
  }

  /** True when values were loaded from localStorage (skip auto perf defaults). */
  hasPersistedSettings(): boolean {
    return this.persisted
  }

  /** User-facing settings (Preferences + ceiling for adaptive). */
  getOptions(): RenderQualityOptions {
    return { ...this.options }
  }

  getTier(): RenderQualityTier {
    return this.options.tier
  }

  getPreset(): GraphicsPreset {
    return this.options.preset
  }

  /** Effective shadow quality for the renderer (includes adaptive step-down). */
  getShadowQuality(): ShadowQuality {
    return this.adaptiveShadowQuality ?? this.options.shadowQuality
  }

  /** User ceiling (Preferences) — ignores adaptive override. */
  getUserShadowQuality(): ShadowQuality {
    return this.options.shadowQuality
  }

  shadowsEnabled(): boolean {
    return this.getShadowQuality() !== 'off'
  }

  /** Avatar cast into the map (needs quality ≠ off). */
  avatarCastShadowsActive(): boolean {
    return this.shadowsEnabled() && this.options.avatarShadowsEnabled
  }

  /** Scene / prop cast into the map (needs quality ≠ off). */
  environmentCastShadowsActive(): boolean {
    return this.shadowsEnabled() && this.options.environmentShadowsEnabled
  }

  getAvatarShadowsEnabled(): boolean {
    return this.options.avatarShadowsEnabled
  }

  getEnvironmentShadowsEnabled(): boolean {
    return this.options.environmentShadowsEnabled
  }

  getShadowMapSize(): number {
    const q = this.getShadowQuality()
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

  /** Effective resolution scale % for the renderer (includes adaptive step-down). */
  getResolutionScale(): number {
    return this.adaptiveResolutionScale ?? this.options.resolutionScale
  }

  /** User ceiling (Preferences) — ignores adaptive override. */
  getUserResolutionScale(): number {
    return this.options.resolutionScale
  }

  getAdaptiveQualityEnabled(): boolean {
    return this.options.adaptiveQualityEnabled
  }

  setAdaptiveQualityEnabled(adaptiveQualityEnabled: boolean): void {
    this.patch({ adaptiveQualityEnabled: !!adaptiveQualityEnabled })
    if (!adaptiveQualityEnabled) this.clearAdaptiveOverrides()
  }

  /**
   * Temporary render overrides. Does **not** change Preferences / localStorage.
   * Pass null to clear that axis.
   */
  setAdaptiveOverrides(opts: {
    resolutionScale?: number | null
    shadowQuality?: ShadowQuality | null
    /** true = force bloom off; false/null = use user bloom toggle. */
    bloomOff?: boolean | null
  }): void {
    let changed = false
    if (opts.resolutionScale !== undefined) {
      const next =
        opts.resolutionScale === null
          ? null
          : clampResolutionScale(opts.resolutionScale)
      if (next !== this.adaptiveResolutionScale) {
        this.adaptiveResolutionScale = next
        changed = true
      }
    }
    if (opts.shadowQuality !== undefined) {
      const next =
        opts.shadowQuality === null
          ? null
          : isShadowQuality(opts.shadowQuality)
            ? opts.shadowQuality
            : this.adaptiveShadowQuality
      if (next !== this.adaptiveShadowQuality) {
        this.adaptiveShadowQuality = next
        changed = true
      }
    }
    if (opts.bloomOff !== undefined) {
      const next = opts.bloomOff === true
      if (next !== this.adaptiveBloomOff) {
        this.adaptiveBloomOff = next
        changed = true
      }
    }
    if (changed) this.notify()
  }

  clearAdaptiveOverrides(): void {
    if (
      this.adaptiveResolutionScale === null &&
      this.adaptiveShadowQuality === null &&
      !this.adaptiveBloomOff
    ) {
      return
    }
    this.adaptiveResolutionScale = null
    this.adaptiveShadowQuality = null
    this.adaptiveBloomOff = false
    this.notify()
  }

  /** True when adaptive is actively lowering something below the user ceiling. */
  isAdaptiveReducing(): boolean {
    return (
      this.adaptiveResolutionScale !== null ||
      this.adaptiveShadowQuality !== null ||
      this.adaptiveBloomOff
    )
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

  /**
   * Effective bloom for the renderer (adaptive may force off under low FPS).
   * Preferences still show {@link options.bloomEnabled}.
   */
  getBloomEnabled(): boolean {
    if (this.adaptiveBloomOff) return false
    return this.options.bloomEnabled
  }

  /** User ceiling (Preferences) — ignores adaptive bloom-off. */
  getUserBloomEnabled(): boolean {
    return this.options.bloomEnabled
  }

  getBloomMode(): BloomModePreference {
    return this.options.bloomMode
  }

  getHdrEnabled(): boolean {
    return this.options.hdrEnabled
  }

  getAvatarToonEnabled(): boolean {
    return this.options.avatarToonEnabled
  }

  getSceneLoadRadiusM(): number {
    return this.options.sceneLoadRadiusM
  }

  /** AOI neighbor scene load radius in meters (0 = primary only). */
  setSceneLoadRadiusM(sceneLoadRadiusM: number): void {
    this.patch({ sceneLoadRadiusM: clampSceneLoadRadiusM(sceneLoadRadiusM) })
  }

  getPrimaryFullRateAnimators(): boolean {
    return this.options.primaryFullRateAnimators
  }

  /** Primary Animator: full scene-tick sampling vs distance/fair LOD. */
  setPrimaryFullRateAnimators(primaryFullRateAnimators: boolean): void {
    this.patch({ primaryFullRateAnimators: !!primaryFullRateAnimators })
  }

  /** Apply a named preset bundle (not custom). Preserves toon + AOI + adaptive + animators + bloom mode + cast splits. */
  applyPreset(preset: PresetId): void {
    const bundle = PRESET_BUNDLES[preset]
    this.commit({
      preset,
      ...bundle,
      avatarToonEnabled: this.options.avatarToonEnabled,
      sceneLoadRadiusM: this.options.sceneLoadRadiusM,
      adaptiveQualityEnabled: this.options.adaptiveQualityEnabled,
      primaryFullRateAnimators: this.options.primaryFullRateAnimators,
      avatarShadowsEnabled: this.options.avatarShadowsEnabled,
      environmentShadowsEnabled: this.options.environmentShadowsEnabled,
      bloomMode: this.options.bloomMode
    })
    // New ceiling — drop temporary overrides so the preset is what you get.
    this.clearAdaptiveOverrides()
  }

  setTier(tier: RenderQualityTier): void {
    this.applyPreset(tier)
  }

  setShadowQuality(shadowQuality: ShadowQuality): void {
    this.patch({ shadowQuality })
    // User raised/lowered ceiling — stop fighting with adaptive on this axis.
    if (this.adaptiveShadowQuality !== null) {
      this.adaptiveShadowQuality = null
      this.notify()
    }
  }

  setAvatarShadowsEnabled(avatarShadowsEnabled: boolean): void {
    this.patch({ avatarShadowsEnabled: !!avatarShadowsEnabled })
  }

  setEnvironmentShadowsEnabled(environmentShadowsEnabled: boolean): void {
    this.patch({ environmentShadowsEnabled: !!environmentShadowsEnabled })
  }

  setSceneLightsEnabled(sceneLightsEnabled: boolean): void {
    this.patch({ sceneLightsEnabled })
  }

  setMaxSceneLights(maxSceneLights: number): void {
    this.patch({ maxSceneLights: clampMaxLights(maxSceneLights) })
  }

  setResolutionScale(resolutionScale: number): void {
    this.patch({ resolutionScale: clampResolutionScale(resolutionScale) })
    if (this.adaptiveResolutionScale !== null) {
      this.adaptiveResolutionScale = null
      this.notify()
    }
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
    // User re-asserted ceiling — clear temporary adaptive bloom-off.
    if (this.adaptiveBloomOff) {
      this.adaptiveBloomOff = false
      this.notify()
    }
  }

  /** Auto / fast (1×) / selective (2×). Only applies while bloom is enabled. */
  setBloomMode(bloomMode: BloomModePreference): void {
    if (!isBloomModePreference(bloomMode)) return
    this.patch({ bloomMode })
  }

  setHdrEnabled(hdrEnabled: boolean): void {
    this.patch({ hdrEnabled })
  }

  setAvatarToonEnabled(avatarToonEnabled: boolean): void {
    this.patch({ avatarToonEnabled })
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
    if (!isBloomModePreference(next.bloomMode)) next.bloomMode = this.options.bloomMode
    if (typeof next.hdrEnabled !== 'boolean') next.hdrEnabled = this.options.hdrEnabled
    if (typeof next.avatarToonEnabled !== 'boolean') next.avatarToonEnabled = this.options.avatarToonEnabled
    if (typeof next.adaptiveQualityEnabled !== 'boolean') {
      next.adaptiveQualityEnabled = this.options.adaptiveQualityEnabled
    }
    if (typeof next.primaryFullRateAnimators !== 'boolean') {
      next.primaryFullRateAnimators = this.options.primaryFullRateAnimators
    }
    if (typeof next.avatarShadowsEnabled !== 'boolean') {
      next.avatarShadowsEnabled = this.options.avatarShadowsEnabled
    }
    if (typeof next.environmentShadowsEnabled !== 'boolean') {
      next.environmentShadowsEnabled = this.options.environmentShadowsEnabled
    }

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
        // avatarToonEnabled intentionally excluded — opt-in aesthetic, not a preset field
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
      a.bloomMode === b.bloomMode &&
      a.hdrEnabled === b.hdrEnabled &&
      a.avatarToonEnabled === b.avatarToonEnabled &&
      a.sceneLoadRadiusM === b.sceneLoadRadiusM &&
      a.adaptiveQualityEnabled === b.adaptiveQualityEnabled &&
      a.primaryFullRateAnimators === b.primaryFullRateAnimators &&
      a.avatarShadowsEnabled === b.avatarShadowsEnabled &&
      a.environmentShadowsEnabled === b.environmentShadowsEnabled
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
      if (isBloomModePreference(parsed.bloomMode)) next.bloomMode = parsed.bloomMode
      if (typeof parsed.hdrEnabled === 'boolean') next.hdrEnabled = parsed.hdrEnabled
      if (typeof parsed.avatarToonEnabled === 'boolean') next.avatarToonEnabled = parsed.avatarToonEnabled
      if (typeof parsed.adaptiveQualityEnabled === 'boolean') {
        next.adaptiveQualityEnabled = parsed.adaptiveQualityEnabled
      }
      if (typeof parsed.primaryFullRateAnimators === 'boolean') {
        next.primaryFullRateAnimators = parsed.primaryFullRateAnimators
      }
      if (typeof parsed.avatarShadowsEnabled === 'boolean') {
        next.avatarShadowsEnabled = parsed.avatarShadowsEnabled
      }
      if (typeof parsed.environmentShadowsEnabled === 'boolean') {
        next.environmentShadowsEnabled = parsed.environmentShadowsEnabled
      }
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
