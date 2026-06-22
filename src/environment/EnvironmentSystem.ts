import * as THREE from 'three'
import type { ResolvedScene, SceneEnvironmentKind, SkyboxConfig } from '../dcl/content/types'
import { landscapeEnvironmentProfile } from '../dcl/landscape/EnvironmentCatalog'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { SceneHost } from '../rendering/SceneHost'
import type { LightManager } from '../rendering/LightManager'
import { renderQuality, TONE_MAPPING_EXPOSURE } from '../rendering/RenderQualitySettings'
import {
  moonExposureMultiplier,
  sceneMoonLightMultiplier,
  sceneSunLightMultiplier,
  sunEnvironmentSettings,
  sunExposureMultiplier
} from '../rendering/SunEnvironmentSettings'
import { DclGenesisSky, sampleSkyGradientsAt } from './DclGenesisSky'
import {
  CYCLE_RATE,
  HEMI_DAY_INTENSITY,
  HEMI_NIGHT_INTENSITY,
  lerpDaySeconds,
  MIDDAY_SECONDS,
  MOON_BRIGHTNESS,
  NIGHT_GROUND_HEMI_BOOST,
  normalizeDaySeconds,
  SUN_BRIGHTNESS,
  TRANSITION_WALL_SEC,
  TransitionMode as TM
} from './skyboxTime'
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
const _blackBackground = new THREE.Color(0x000000)
/** Neutral void for blank scenes — no genesis dome nadir showing as a cyan “floor”. */
const VOID_SKY_BACKGROUND = 0x1a1a2e
/** Exposure when scene.json disables celestial lights — ECS LightSource carries the scene. */
const CELESTIAL_OFF_EXPOSURE = 0.1

/** Max reduction of sun/hemi when the nearby ECS light budget is fully saturated. */
const ECS_HYBRID_SUN_REDUCTION = 0.25
/** Hybrid dimming starts once this fraction of the quality-tier light budget is in use. */
const ECS_HYBRID_FILL_START = 0.4

/** DCL GenesisSky dome + sun/moon lighting — driven by SkyboxTime + SunCycle24h.anim. */
export class EnvironmentSystem {
  private readonly genesisSky: DclGenesisSky
  private readonly sun: THREE.DirectionalLight
  private readonly moon: THREE.DirectionalLight
  private readonly hemi: THREE.HemisphereLight
  private customCube: THREE.CubeTexture | null = null
  private customBackground: THREE.Texture | null = null

  private displayTime = MIDDAY_SECONDS
  private targetTime = MIDDAY_SECONDS
  private transitionFrom = MIDDAY_SECONDS
  private transitionProgress = 1
  private transitionBackward = false
  private fixedMode = false
  private cycleMode = true
  private freezeClouds = false
  private uiOverrideTime: number | null = null
  private lastSkyboxKey = ''
  private landscapeKind: SceneEnvironmentKind = 'island'
  private disableSun = false
  private disableMoon = false
  private readonly outdoorLighting = createOutdoorLightingSnapshot()

  constructor(
    private readonly host: SceneHost,
    private readonly lightManager?: LightManager
  ) {
    this.genesisSky = new DclGenesisSky()

    this.hemi = new THREE.HemisphereLight(0xddeeff, 0x445533, 0.55)
    this.sun = new THREE.DirectionalLight(0xffffff, 1.0)
    this.sun.castShadow = false

    this.moon = new THREE.DirectionalLight(0x8370ff, 0.4)
    this.moon.castShadow = false

    this.sun.target = new THREE.Object3D()
    this.moon.target = new THREE.Object3D()
  }

  async init(scene: ResolvedScene): Promise<void> {
    const threeScene = this.host.scene
    this.landscapeKind = scene.landscapeEnvironment
    this.disableSun = scene.skyLighting.disableSun
    this.disableMoon = scene.skyLighting.disableMoon
    const landscapeProfile = landscapeEnvironmentProfile(this.landscapeKind)

    threeScene.add(this.genesisSky.mesh)
    threeScene.add(this.hemi)
    threeScene.add(this.sun)
    threeScene.add(this.sun.target)
    threeScene.add(this.moon)
    threeScene.add(this.moon.target)

    const initial = scene.skybox?.fixedTime
    if (typeof initial === 'number' && Number.isFinite(initial)) {
      this.displayTime = normalizeDaySeconds(initial)
      this.targetTime = this.displayTime
      this.fixedMode = true
      this.cycleMode = false
    } else {
      this.displayTime = MIDDAY_SECONDS
      this.targetTime = MIDDAY_SECONDS
      this.cycleMode = true
    }

    await this.applyCustomSkybox(scene.skybox, scene.assetUrl)
    const hideSkyDome = landscapeProfile.spaceSky === true || landscapeProfile.voidSky === true
    if (!this.customCube && !this.customBackground && !hideSkyDome) {
      await this.genesisSky.loadTextures()
    } else if (landscapeProfile.spaceSky) {
      this.host.scene.background = new THREE.Color(0x020208)
      this.genesisSky.mesh.visible = false
    } else if (landscapeProfile.voidSky) {
      this.host.scene.background = new THREE.Color(VOID_SKY_BACKGROUND)
      this.genesisSky.mesh.visible = false
    }
    this.applyTime(this.displayTime, 0)
  }

  update(delta: number, view: ProjectionView, components: MirrorComponents): void {
    if (this.uiOverrideTime === null) {
      this.syncSkyboxTime(view, components)
    }

    if (this.transitionProgress < 1) {
      this.transitionProgress = Math.min(1, this.transitionProgress + delta / TRANSITION_WALL_SEC)
      this.displayTime = lerpDaySeconds(
        this.transitionFrom,
        this.targetTime,
        this.transitionProgress,
        this.transitionBackward
      )
    } else if (this.uiOverrideTime !== null) {
      this.displayTime = this.uiOverrideTime
    } else if (this.cycleMode && !this.fixedMode) {
      this.displayTime = normalizeDaySeconds(this.displayTime + delta * CYCLE_RATE)
    } else {
      this.displayTime = this.targetTime
    }

    this.applyTime(this.displayTime, delta)
  }

  dispose(): void {
    this.genesisSky.dispose()
    this.genesisSky.mesh.removeFromParent()
    this.hemi.removeFromParent()
    this.sun.removeFromParent()
    this.sun.target.removeFromParent()
    this.moon.removeFromParent()
    this.moon.target.removeFromParent()
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

  /** True when UI auto cycle is running (not manual override). */
  isUiAutoCycle(): boolean {
    return this.uiOverrideTime === null && this.cycleMode
  }

  /** True when the player pinned a manual time via the skybox panel. */
  isUiManualOverride(): boolean {
    return this.uiOverrideTime !== null
  }

  /** UI skybox slider — pauses ECS sync while active. Pass null to resume cycle/ECS. */
  setUiTimeOverride(seconds: number | null): void {
    if (seconds === null) {
      this.uiOverrideTime = null
      this.freezeClouds = false
      return
    }
    this.uiOverrideTime = normalizeDaySeconds(seconds)
    this.freezeClouds = true
    this.fixedMode = true
    this.cycleMode = false
    this.displayTime = this.uiOverrideTime
    this.targetTime = this.uiOverrideTime
    this.transitionProgress = 1
  }

  setUiCycleEnabled(enabled: boolean): void {
    if (enabled) {
      this.uiOverrideTime = null
      this.fixedMode = false
      this.cycleMode = true
      this.freezeClouds = false
      this.targetTime = this.displayTime
      this.transitionProgress = 1
      return
    }
    this.setUiTimeOverride(this.displayTime)
  }

  private syncSkyboxTime(view: ProjectionView, { SkyboxTime }: MirrorComponents): void {
    const root = view.RootEntity
    const has = SkyboxTime.has(root)
    const key = has
      ? `${SkyboxTime.get(root).fixedTime}|${SkyboxTime.get(root).transitionMode ?? TM.TM_FORWARD}`
      : 'cycle'

    if (key === this.lastSkyboxKey) return
    this.lastSkyboxKey = key

    if (!has) {
      this.fixedMode = false
      this.cycleMode = true
      this.freezeClouds = false
      return
    }

    const { fixedTime, transitionMode } = SkyboxTime.get(root)
    this.fixedMode = true
    this.cycleMode = false
    this.freezeClouds = true
    this.beginTransition(
      this.displayTime,
      normalizeDaySeconds(fixedTime),
      (transitionMode ?? TM.TM_FORWARD) === TM.TM_BACKWARD
    )
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
    const spaceSky = landscapeProfile.spaceSky === true
    const voidSky = landscapeProfile.voidSky === true
    const useGenesis =
      !this.customCube && !this.customBackground && !spaceSky && !voidSky && !skylightOff
    this.genesisSky.mesh.visible = useGenesis

    if (useGenesis) {
      this.genesisSky.mesh.position.copy(this.host.camera.position)
      this.genesisSky.update(seconds, _celestial, delta, this.freezeClouds)
      if (this.disableSun) {
        this.genesisSky.uniforms.uSunRadiance.value = 0
      }
      if (this.disableMoon) {
        this.genesisSky.uniforms.uMoonMask.value = 0
      }
    }

    const sunScale = this.hybridSunScale()
    const moonScale = 1 - (1 - sunScale) * 0.4
    const lighting = sunEnvironmentSettings.get()
    const sceneSunMul = sceneSunLightMultiplier(lighting.sceneSunLight)
    const sceneMoonMul = sceneMoonLightMultiplier(lighting.sceneMoonLight)

    this.sun.intensity = this.disableSun
      ? 0
      : (day ? lit * SUN_BRIGHTNESS : 0.02) * sunScale * sceneSunMul
    this.sun.color.copy(g.directional)
    this.sun.position.copy(_celestial).multiplyScalar(120)
    this.sun.target.position.set(0, 0, 0)

    const moonLit = moonLightIntensity(seconds)
    this.moon.intensity = this.disableMoon
      ? 0
      : day
        ? 0
        : moonLit * MOON_BRIGHTNESS * moonScale * sceneMoonMul
    this.moon.color.copy(g.directional)
    this.moon.position.copy(_celestial).multiplyScalar(120)
    this.moon.target.position.set(0, 0, 0)

    this.hemi.intensity = skylightOff
      ? 0
      : (day ? HEMI_DAY_INTENSITY * sceneSunMul : HEMI_NIGHT_INTENSITY * sceneMoonMul) * sunScale
    this.hemi.color.copy(g.indirectSky)
    _hemiGround.copy(g.indirectGround)
    if (!day) _hemiGround.multiplyScalar(NIGHT_GROUND_HEMI_BOOST)
    this.hemi.groundColor.copy(_hemiGround)

    const tierExposure = TONE_MAPPING_EXPOSURE[renderQuality.getTier()]
    this.host.renderer.toneMappingExposure = skylightOff
      ? tierExposure * CELESTIAL_OFF_EXPOSURE
      : tierExposure *
        (day ? sunExposureMultiplier(lighting.exposure) : moonExposureMultiplier(lighting.moonExposure))

    if (spaceSky) {
      if (!(this.host.scene.background instanceof THREE.Color)) {
        this.host.scene.background = new THREE.Color(0x020208)
      }
      if (skylightOff) {
        ;(this.host.scene.background as THREE.Color).setHex(0x000000)
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
    if (active <= 0) return 1
    const max = renderQuality.getMaxActiveLights()
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
