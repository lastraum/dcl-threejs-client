import * as THREE from 'three'
import type {
  ResolvedScene,
  SceneEnvironmentConfig,
  SceneEnvironmentKind,
  SkyboxConfig
} from '../dcl/content/types'
import { landscapeEnvironmentProfile } from '../dcl/landscape/EnvironmentCatalog'
import { SpaceSkyField } from './SpaceSkyField'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { SceneHost } from '../rendering/SceneHost'
import type { LightManager } from '../rendering/LightManager'
import { renderQuality, TONE_MAPPING_EXPOSURE } from '../rendering/RenderQualitySettings'
import {
  moonExposureMultiplier,
  sceneMoonLightMultiplier,
  sceneSunLightMultiplier,
  isDefaultSunEnvironmentSettings,
  sunEnvironmentSettings,
  sunExposureMultiplier,
  type SunEnvironmentSettingsState
} from '../rendering/SunEnvironmentSettings'
import { DclGenesisSky, sampleSkyGradientsAt } from './DclGenesisSky'
import {
  CYCLE_RATE,
  EQUATOR_AMBIENT_DAY,
  EQUATOR_AMBIENT_NIGHT,
  HEMI_DAY_INTENSITY,
  HEMI_NIGHT_INTENSITY,
  lerpDaySeconds,
  loadSessionSkyboxPreference,
  MIDDAY_SECONDS,
  MOON_BRIGHTNESS,
  NIGHT_GROUND_HEMI_BOOST,
  normalizeDaySeconds,
  saveSessionSkyboxPreference,
  SUN_BRIGHTNESS,
  TRANSITION_WALL_SEC,
  TransitionMode as TM
} from './skyboxTime'
import {
  configureDirectionalSunShadow,
  refreshDirectionalSunShadowMapSize,
  updateDirectionalSunShadowFocus
} from '../rendering/directionalSunShadow'
import {
  createOutdoorLightingSnapshot,
  syncOutdoorLightingFromLights,
  type OutdoorLightingSnapshot
} from './OutdoorLighting'
import {
  animatedLightIntensity,
  celestialDirection,
  isSunPeriod,
  moonLightIntensity
} from './sunCycleSampler'

const _celestial = new THREE.Vector3()
const _hemiGround = new THREE.Color()
const _moonCool = new THREE.Color(0.55, 0.62, 0.95)
const _blackBackground = new THREE.Color(0x000000)
/** Neutral void for blank scenes — no genesis dome nadir showing as a cyan “floor”. */
const VOID_SKY_BACKGROUND = 0x1a1a2e
/** Exposure when scene.json disables celestial lights — ECS LightSource carries the scene. */
const CELESTIAL_OFF_EXPOSURE = 0.1

/** Max reduction of sun/hemi when the nearby ECS light budget is fully saturated. */
const ECS_HYBRID_SUN_REDUCTION = 0.25
/** Hybrid dimming starts once this fraction of the quality-tier light budget is in use. */
const ECS_HYBRID_FILL_START = 0.4

/** Map resolved creator lighting (from scene.json `environment`) to panel state keys. */
function sceneLightingFromResolvedSkybox(skybox?: SkyboxConfig): Partial<SunEnvironmentSettingsState> {
  if (!skybox) return {}
  const finite = (v: number | undefined): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? v : undefined
  const out: Partial<SunEnvironmentSettingsState> = {}
  const sunLight = finite(skybox.sunLight)
  const exposure = finite(skybox.exposure)
  const moonLight = finite(skybox.moonLight)
  const moonExposure = finite(skybox.moonExposure)
  if (sunLight !== undefined) out.sceneSunLight = sunLight
  if (exposure !== undefined) out.exposure = exposure
  if (moonLight !== undefined) out.sceneMoonLight = moonLight
  if (moonExposure !== undefined) out.moonExposure = moonExposure
  return out
}

/** DCL GenesisSky dome + sun/moon lighting — driven by SkyboxTime + SunCycle24h.anim. */
export class EnvironmentSystem {
  private readonly genesisSky: DclGenesisSky
  private readonly sun: THREE.DirectionalLight
  private readonly moon: THREE.DirectionalLight
  /** Unity Trilight: sky + ground (HemisphereLight). */
  private readonly hemi: THREE.HemisphereLight
  /** Unity Trilight equator band — soft fill on vertical surfaces (AmbientLight). */
  private readonly equatorAmbient: THREE.AmbientLight
  private customCube: THREE.CubeTexture | null = null
  private customBackground: THREE.Texture | null = null

  private displayTime = MIDDAY_SECONDS
  private targetTime = MIDDAY_SECONDS
  private transitionFrom = MIDDAY_SECONDS
  private transitionProgress = 1
  private transitionBackward = false
  /**
   * Skybox time authority (highest wins):
   * 1) Scene fixed — scene.json `skyboxConfig.fixedTime` or ECS `SkyboxTime`
   * 2) Session custom — Night/Day panel (sessionStorage)
   * 3) Auto — 60× day cycle
   */
  private sceneJsonFixedTime: number | null = null
  /** True while scene.json or ECS locks time (beats session custom + auto). */
  private sceneLocked = false
  private cycleMode = true
  /** Session custom TOD when not scene-locked; persisted in sessionStorage. */
  private uiOverrideTime: number | null = null
  private lastSkyboxKey = ''
  /** First ECS SkyboxTime after init snaps; later changes use TRANSITION_WALL_SEC. */
  private ecsSkyboxEverApplied = false
  private landscapeKind: SceneEnvironmentKind = 'island'
  private disableSun = false
  private disableMoon = false
  /** Creator sun/moon values from scene.json `environment` (issue #8) — per-scene defaults. */
  private sceneLighting: Partial<SunEnvironmentSettingsState> = {}
  /** Panel fields the player adjusted this scene — player wins over creator defaults. */
  private readonly userAdjustedLighting = new Set<keyof SunEnvironmentSettingsState>()
  private lastUserLighting: SunEnvironmentSettingsState | null = null
  private unsubscribeLighting: (() => void) | null = null
  /** Help panel — hide genesis dome and use void sky while keeping custom skybox textures. */
  private landscapeVisualSuppressed = false
  private readonly outdoorLighting = createOutdoorLightingSnapshot()
  /** Space biome starfield / void plate (when kind === space). */
  private spaceSky: SpaceSkyField | null = null

  constructor(
    private readonly host: SceneHost,
    private readonly lightManager?: LightManager
  ) {
    this.genesisSky = new DclGenesisSky()

    // Construct defaults match Explorer noon-ish trilight until first applyTime overwrites.
    // Equator lavender + dark red ground (not cool cyan / green) — softer yellow outdoor fill.
    this.hemi = new THREE.HemisphereLight(0x84adc0, 0x951a17, 0.42)
    this.equatorAmbient = new THREE.AmbientLight(0xbba5c9, 0.48)
    this.sun = new THREE.DirectionalLight(0xfff4d6, 1.0)
    configureDirectionalSunShadow(this.sun)

    this.moon = new THREE.DirectionalLight(0x8370ff, 0.4)
    configureDirectionalSunShadow(this.moon)
    this.moon.castShadow = false

    this.sun.target = new THREE.Object3D()
    this.moon.target = new THREE.Object3D()
  }

  async init(scene: ResolvedScene): Promise<void> {
    const threeScene = this.host.scene
    this.landscapeVisualSuppressed = false
    this.landscapeKind = scene.landscapeEnvironment
    this.disableSun = scene.skyLighting.disableSun
    this.disableMoon = scene.skyLighting.disableMoon
    const landscapeProfile = landscapeEnvironmentProfile(this.landscapeKind)

    threeScene.add(this.genesisSky.mesh)
    threeScene.add(this.hemi)
    threeScene.add(this.equatorAmbient)
    threeScene.add(this.sun)
    threeScene.add(this.sun.target)
    threeScene.add(this.moon)
    threeScene.add(this.moon.target)

    this.sceneLighting = sceneLightingFromResolvedSkybox(scene.skybox)
    this.userAdjustedLighting.clear()
    this.lastUserLighting = sunEnvironmentSettings.get()
    this.unsubscribeLighting?.()
    this.unsubscribeLighting = sunEnvironmentSettings.subscribe((state) => {
      const prev = this.lastUserLighting
      this.lastUserLighting = state
      if (!prev) return
      // Reset lighting → re-enable creator `environment` defaults for this scene.
      if (isDefaultSunEnvironmentSettings(state)) {
        this.userAdjustedLighting.clear()
        return
      }
      for (const key of Object.keys(state) as Array<keyof SunEnvironmentSettingsState>) {
        if (state[key] !== prev[key]) this.userAdjustedLighting.add(key)
      }
    })

    this.lastSkyboxKey = ''
    this.ecsSkyboxEverApplied = false
    this.transitionProgress = 1
    this.applyInitialTimeAuthority(scene)

    await this.applyCustomSkybox(scene.skybox, scene.assetUrl)
    const hideSkyDome = landscapeProfile.spaceSky === true || landscapeProfile.voidSky === true
    if (!this.customCube && !this.customBackground && !hideSkyDome) {
      await this.genesisSky.loadTextures()
    } else if (landscapeProfile.spaceSky) {
      this.genesisSky.mesh.visible = false
      this.mountSpaceSky(scene)
    } else if (landscapeProfile.voidSky) {
      this.host.scene.background = new THREE.Color(VOID_SKY_BACKGROUND)
      this.genesisSky.mesh.visible = false
    }
    this.applyTime(this.displayTime, 0)
  }

  private mountSpaceSky(scene: ResolvedScene): void {
    this.spaceSky?.dispose()
    this.spaceSky = null
    const env = scene.metadata?.environment
    const spaceCfg =
      env && typeof env === 'object' && !Array.isArray(env)
        ? (env as SceneEnvironmentConfig).space
        : undefined
    this.spaceSky = SpaceSkyField.create(spaceCfg)
    this.spaceSky.mount(this.host.scene)
  }

  /** Runtime debug — suppress genesis sky dome (landscape/ocean hidden separately in World). */
  setLandscapeVisualSuppressed(suppressed: boolean): void {
    this.landscapeVisualSuppressed = suppressed
  }

  isLandscapeVisualSuppressed(): boolean {
    return this.landscapeVisualSuppressed
  }

  update(delta: number, view: ProjectionView, components: MirrorComponents): void {
    // Always sync scene lock (priority 1) so it can preempt session custom.
    this.syncSkyboxTime(view, components)

    if (this.transitionProgress < 1) {
      this.transitionProgress = Math.min(1, this.transitionProgress + delta / TRANSITION_WALL_SEC)
      this.displayTime = lerpDaySeconds(
        this.transitionFrom,
        this.targetTime,
        this.transitionProgress,
        this.transitionBackward
      )
    } else if (this.sceneLocked) {
      this.displayTime = this.targetTime
    } else if (this.uiOverrideTime !== null) {
      this.displayTime = this.uiOverrideTime
    } else if (this.cycleMode) {
      this.displayTime = normalizeDaySeconds(this.displayTime + delta * CYCLE_RATE)
    } else {
      this.displayTime = this.targetTime
    }

    this.applyTime(this.displayTime, delta)
    if (this.spaceSky) {
      this.spaceSky.update(delta, this.host.camera)
    }
  }

  /** Player panel (fields touched this scene) > scene.json `environment` > player store defaults. */
  private effectiveLighting(): SunEnvironmentSettingsState {
    const user = sunEnvironmentSettings.get()
    const merged = { ...user }
    for (const key of Object.keys(this.sceneLighting) as Array<keyof SunEnvironmentSettingsState>) {
      const sceneValue = this.sceneLighting[key]
      if (sceneValue !== undefined && !this.userAdjustedLighting.has(key)) {
        merged[key] = sceneValue
      }
    }
    return merged
  }

  dispose(): void {
    this.landscapeVisualSuppressed = false
    this.unsubscribeLighting?.()
    this.unsubscribeLighting = null
    this.sceneLighting = {}
    this.userAdjustedLighting.clear()
    this.lastUserLighting = null
    this.spaceSky?.dispose()
    this.spaceSky = null
    this.genesisSky.dispose()
    this.genesisSky.mesh.removeFromParent()
    this.hemi.removeFromParent()
    this.equatorAmbient.removeFromParent()
    this.sun.removeFromParent()
    this.sun.target.removeFromParent()
    this.moon.removeFromParent()
    this.moon.target.removeFromParent()
    this.sun.shadow.map?.dispose()
    this.moon.shadow.map?.dispose()
    this.customCube?.dispose()
    this.customBackground?.dispose()
  }

  getTimeOfDay(): number {
    return this.displayTime
  }

  /** Latest sun/moon + sky colours — updated every `update()` / `applyTime()`. */
  getOutdoorLighting(): Readonly<OutdoorLightingSnapshot> {
    return this.outdoorLighting
  }

  /** True when Auto is active (not scene-locked, no session custom). */
  isUiAutoCycle(): boolean {
    return !this.sceneLocked && this.uiOverrideTime === null && this.cycleMode
  }

  /** True when session custom TOD is active (not scene-locked). */
  isUiManualOverride(): boolean {
    return !this.sceneLocked && this.uiOverrideTime !== null
  }

  /** Scene.json or ECS fixed time currently owns the clock. */
  isSceneTimeLocked(): boolean {
    return this.sceneLocked
  }

  /**
   * Session custom TOD (priority 2). Stored in sessionStorage for the tab.
   * No-ops display while scene-locked, but still persists for when the lock clears.
   * Pass null to clear custom and fall through to Auto (if not scene-locked).
   */
  setUiTimeOverride(seconds: number | null): void {
    if (seconds === null) {
      this.uiOverrideTime = null
      saveSessionSkyboxPreference({ mode: 'auto' })
      if (!this.sceneLocked) {
        this.cycleMode = true
        this.targetTime = this.displayTime
        this.transitionProgress = 1
      }
      return
    }

    const t = normalizeDaySeconds(seconds)
    this.uiOverrideTime = t
    saveSessionSkyboxPreference({ mode: 'custom', seconds: t })
    this.cycleMode = false
    if (!this.sceneLocked) {
      this.displayTime = t
      this.targetTime = t
      this.transitionProgress = 1
    }
  }

  setUiCycleEnabled(enabled: boolean): void {
    if (enabled) {
      this.uiOverrideTime = null
      saveSessionSkyboxPreference({ mode: 'auto' })
      if (!this.sceneLocked) {
        this.cycleMode = true
        this.targetTime = this.displayTime
        this.transitionProgress = 1
      }
      return
    }
    // Pin current display as session custom (priority 2).
    this.setUiTimeOverride(this.displayTime)
  }

  /**
   * Priority on boot:
   * 1) scene.json fixedTime → 2) session custom → 3) auto from midday.
   * ECS SkyboxTime is applied later in update via syncSkyboxTime (still priority 1).
   */
  private applyInitialTimeAuthority(scene: ResolvedScene): void {
    const raw = scene.skybox?.fixedTime
    this.sceneJsonFixedTime =
      typeof raw === 'number' && Number.isFinite(raw) ? normalizeDaySeconds(raw) : null

    const session = loadSessionSkyboxPreference()
    this.uiOverrideTime = session.mode === 'custom' ? session.seconds : null

    if (this.sceneJsonFixedTime !== null) {
      this.sceneLocked = true
      this.cycleMode = false
      this.displayTime = this.sceneJsonFixedTime
      this.targetTime = this.sceneJsonFixedTime
      return
    }

    this.sceneLocked = false
    if (this.uiOverrideTime !== null) {
      this.cycleMode = false
      this.displayTime = this.uiOverrideTime
      this.targetTime = this.uiOverrideTime
      return
    }

    this.cycleMode = true
    this.displayTime = MIDDAY_SECONDS
    this.targetTime = MIDDAY_SECONDS
  }

  private applyUnlockedFallback(): void {
    this.sceneLocked = false
    if (this.uiOverrideTime !== null) {
      this.cycleMode = false
      this.displayTime = this.uiOverrideTime
      this.targetTime = this.uiOverrideTime
      this.transitionProgress = 1
      return
    }
    this.cycleMode = true
  }

  private syncSkyboxTime(view: ProjectionView, { SkyboxTime }: MirrorComponents): void {
    const root = view.RootEntity
    const hasEcs = SkyboxTime.has(root)
    const key = hasEcs
      ? `ecs:${SkyboxTime.get(root).fixedTime}|${SkyboxTime.get(root).transitionMode ?? TM.TM_FORWARD}`
      : this.sceneJsonFixedTime !== null
        ? `json:${this.sceneJsonFixedTime}`
        : 'unlocked'

    if (key === this.lastSkyboxKey) return
    this.lastSkyboxKey = key

    if (hasEcs) {
      const { fixedTime, transitionMode } = SkyboxTime.get(root)
      const to = normalizeDaySeconds(fixedTime)
      const backward = (transitionMode ?? TM.TM_FORWARD) === TM.TM_BACKWARD
      this.sceneLocked = true
      this.cycleMode = false

      // Cold bind: snap (avoid 4s dark→bright on load). Live scene changes: smooth transition.
      if (!this.ecsSkyboxEverApplied) {
        this.ecsSkyboxEverApplied = true
        this.displayTime = to
        this.targetTime = to
        this.transitionProgress = 1
        return
      }
      this.beginTransition(this.displayTime, to, backward)
      return
    }

    if (this.sceneJsonFixedTime !== null) {
      this.sceneLocked = true
      this.cycleMode = false
      this.displayTime = this.sceneJsonFixedTime
      this.targetTime = this.sceneJsonFixedTime
      this.transitionProgress = 1
      return
    }

    // Priority 2 session custom, else priority 3 auto.
    this.applyUnlockedFallback()
  }

  private beginTransition(from: number, to: number, backward: boolean): void {
    this.transitionFrom = from
    this.targetTime = to
    this.transitionBackward = backward
    this.transitionProgress = 0
  }

  /** Sun/moon directional + hemisphere fill suppressed for the current day/night period. */
  private celestialSkylightSuppressed(day: boolean): boolean {
    if (this.disableSun && this.disableMoon) return true
    if (this.disableSun && day) return true
    if (this.disableMoon && !day) return true
    return false
  }

  private applyTime(seconds: number, delta: number): void {
    celestialDirection(seconds, _celestial)
    const day = isSunPeriod(seconds)
    const g = sampleSkyGradientsAt(seconds)
    const lit = animatedLightIntensity(seconds)

    const skylightOff = this.celestialSkylightSuppressed(day)
    const landscapeProfile = landscapeEnvironmentProfile(this.landscapeKind)
    const forceVoidSky = this.landscapeVisualSuppressed
    const spaceSky = !forceVoidSky && landscapeProfile.spaceSky === true
    const voidSky = forceVoidSky || landscapeProfile.voidSky === true
    const useGenesis =
      !forceVoidSky &&
      !this.customCube &&
      !this.customBackground &&
      !spaceSky &&
      !voidSky &&
      !skylightOff
    this.genesisSky.mesh.visible = useGenesis

    if (useGenesis) {
      this.genesisSky.mesh.position.copy(this.host.camera.position)
      // Fixed TOD freezes the *sun clock*, not cloud drift — always scroll clouds.
      this.genesisSky.update(seconds, _celestial, delta, false)
      if (this.disableSun) {
        this.genesisSky.uniforms.uSunRadiance.value = 0
      }
      if (this.disableMoon) {
        this.genesisSky.uniforms.uMoonMask.value = 0
      }
    }

    const sunScale = this.hybridSunScale()
    const moonScale = 1 - (1 - sunScale) * 0.4
    const lighting = this.effectiveLighting()
    const sceneSunMul = sceneSunLightMultiplier(lighting.sceneSunLight)
    const sceneMoonMul = sceneMoonLightMultiplier(lighting.sceneMoonLight)
    const ambientMul = (day ? sceneSunMul : sceneMoonMul) * sunScale

    // Directional: Unity uses anim intensity ~2.72 peak × color ramp (SUN_BRIGHTNESS ≈ 1).
    this.sun.intensity = this.disableSun
      ? 0
      : (day ? lit * SUN_BRIGHTNESS : 0.02) * sunScale * sceneSunMul
    this.sun.color.copy(g.directional)

    const moonLit = moonLightIntensity(seconds)
    this.moon.intensity = this.disableMoon
      ? 0
      : day
        ? 0
        : moonLit * MOON_BRIGHTNESS * moonScale * sceneMoonMul
    // Cool moon fill — Unity night directional is purple/blue from the ramp, not warm sun.
    this.moon.color.copy(g.directional).lerp(_moonCool, 0.4)
    // Anchor moon light on camera focus so night scenes get stable directional fill.
    this.moon.target.position.copy(this.host.camera.position)
    this.moon.position.copy(this.host.camera.position).addScaledVector(_celestial, 90)
    this.moon.target.updateMatrixWorld()

    // Trilight ambient (SkyboxRenderController.UpdateIndirectLight).
    this.hemi.intensity = skylightOff ? 0 : (day ? HEMI_DAY_INTENSITY : HEMI_NIGHT_INTENSITY) * ambientMul
    this.hemi.color.copy(g.indirectSky)
    _hemiGround.copy(g.indirectGround)
    if (!day) _hemiGround.multiplyScalar(NIGHT_GROUND_HEMI_BOOST)
    this.hemi.groundColor.copy(_hemiGround)

    this.equatorAmbient.intensity = skylightOff
      ? 0
      : (day ? EQUATOR_AMBIENT_DAY : EQUATOR_AMBIENT_NIGHT) * ambientMul
    this.equatorAmbient.color.copy(g.indirectEquator)

    // Soft directional shadows: sun by day, moon by night (Unity soft directional feel).
    const sunShadowsOn = !skylightOff && day && !this.disableSun && this.sun.intensity > 0.05
    const moonShadowsOn =
      !skylightOff && !day && !this.disableMoon && this.moon.intensity > 0.08
    refreshDirectionalSunShadowMapSize(this.sun)
    refreshDirectionalSunShadowMapSize(this.moon)
    if (sunShadowsOn) {
      updateDirectionalSunShadowFocus(this.sun, this.host.camera.position, _celestial, true)
      this.moon.castShadow = false
    } else if (moonShadowsOn) {
      this.sun.castShadow = false
      this.sun.position.copy(_celestial).multiplyScalar(120)
      this.sun.target.position.set(0, 0, 0)
      updateDirectionalSunShadowFocus(this.moon, this.host.camera.position, _celestial, true)
    } else {
      this.sun.castShadow = false
      this.moon.castShadow = false
      this.sun.position.copy(_celestial).multiplyScalar(120)
      this.sun.target.position.set(0, 0, 0)
    }

    const tierExposure = TONE_MAPPING_EXPOSURE[renderQuality.getTier()]
    this.host.renderer.toneMappingExposure = skylightOff
      ? tierExposure * CELESTIAL_OFF_EXPOSURE
      : tierExposure *
        (day ? sunExposureMultiplier(lighting.exposure) : moonExposureMultiplier(lighting.moonExposure))

    if (spaceSky) {
      // SpaceSkyField owns background + fog; only force black when skylight fully off.
      if (skylightOff && this.host.scene.background instanceof THREE.Color) {
        ;(this.host.scene.background as THREE.Color).setHex(0x000000)
      } else if (this.spaceSky) {
        // Keep plate from SpaceSkyField; no-op each frame is fine.
      } else if (!(this.host.scene.background instanceof THREE.Color)) {
        this.host.scene.background = new THREE.Color(0x020208)
      }
    } else if (voidSky) {
      if (!(this.host.scene.background instanceof THREE.Color)) {
        this.host.scene.background = new THREE.Color(VOID_SKY_BACKGROUND)
      }
      ;(this.host.scene.background as THREE.Color).setHex(skylightOff ? 0x000000 : VOID_SKY_BACKGROUND)
    } else if (skylightOff && this.host.scene.background instanceof THREE.Color) {
      this.host.scene.background.copy(_blackBackground)
    } else if (useGenesis && this.host.scene.background instanceof THREE.Color) {
      this.host.scene.background.copy(g.indirectSky)
    }

    syncOutdoorLightingFromLights(
      this.outdoorLighting,
      this.sun,
      this.moon,
      this.hemi,
      this.equatorAmbient,
      { horizon: g.horizon, zenit: g.zenit },
      day
    )
  }

  /**
   * Blend down hardcoded sun/moon/hemi when the ECS light budget is saturated nearby
   * so Genesis Plaza-style clusters are not double-lit. Sparse outdoor scenes keep full sun.
   */
  private hybridSunScale(): number {
    if (!this.lightManager) return 1
    const active = this.lightManager.getActiveNearbyCount()
    const max = renderQuality.getMaxActiveLights()
    if (active <= 0 || max <= 0) return 1
    const fill = active / max
    if (fill <= ECS_HYBRID_FILL_START) return 1
    const t = (fill - ECS_HYBRID_FILL_START) / (1 - ECS_HYBRID_FILL_START)
    return 1 - t * ECS_HYBRID_SUN_REDUCTION
  }

  private async applyCustomSkybox(config: SkyboxConfig | undefined, assetUrl: (hash: string) => string): Promise<void> {
    const textures = config?.textures?.filter(Boolean) ?? []
    if (!textures.length) return

    try {
      if (textures.length >= 6) {
        const loader = new THREE.CubeTextureLoader()
        const urls = textures.slice(0, 6).map((entry) => resolveTextureUrl(entry, assetUrl))
        this.customCube = await loader.loadAsync(urls)
        this.host.scene.background = this.customCube
        this.genesisSky.mesh.visible = false
        return
      }

      const loader = new THREE.TextureLoader()
      this.customBackground = await loader.loadAsync(resolveTextureUrl(textures[0]!, assetUrl))
      this.customBackground.colorSpace = THREE.SRGBColorSpace
      this.host.scene.background = this.customBackground
      this.genesisSky.mesh.visible = false
    } catch (err) {
      console.warn('[environment] custom skybox load failed — using GenesisSky', err)
    }
  }
}

function resolveTextureUrl(entry: string, assetUrl: (hash: string) => string): string {
  const trimmed = entry.trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return assetUrl(trimmed)
  return trimmed
}
