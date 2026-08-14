import * as THREE from 'three'
import { PMREMGenerator } from 'three'

/**
 * AAA outdoor IBL — low-rate sky probe, not full GI / per-frame PMREM.
 *
 * Explorer bakes skybox → cubemap for ambient reflections. We approximate with a
 * tiny hemi-lit probe scene from Trilight colors, re-baked only when TOD bucket
 * changes (~12 buckets / day). scene.environmentIntensity scales contribution.
 */

/** Daytime soft fill — keep below 0.5 so ACES + sun stay primary. */
export const OUTDOOR_IBL_INTENSITY_DAY = 0.32
/** Night probe — low so moon/hemi own the key; was 0.22 and washed 00:00. */
export const OUTDOOR_IBL_INTENSITY_NIGHT = 0.1

/** Normalized TOD quantized into this many rebuilds per day (AAA: not every frame). */
const TOD_BUCKETS = 12

export type OutdoorIblColors = {
  sky: THREE.Color
  ground: THREE.Color
  equator: THREE.Color
}

export class OutdoorIbl {
  private readonly pmrem: PMREMGenerator
  private envRT: THREE.WebGLRenderTarget | null = null
  private lastBucket = -1
  private enabled = true

  constructor(renderer: THREE.WebGLRenderer) {
    this.pmrem = new PMREMGenerator(renderer)
    this.pmrem.compileEquirectangularShader()
  }

  /**
   * Update scene.environment when day bucket / skylight gate changes.
   * Safe to call every frame — rebuild is rare.
   */
  sync(
    scene: THREE.Scene,
    colors: OutdoorIblColors,
    opts: { daySeconds: number; isDay: boolean; skylightOff: boolean; force?: boolean }
  ): void {
    if (opts.skylightOff) {
      this.clear(scene)
      return
    }
    if (!this.enabled) return

    const t = ((opts.daySeconds % 86400) + 86400) % 86400
    const bucket = Math.floor((t / 86400) * TOD_BUCKETS) % TOD_BUCKETS
    if (!opts.force && bucket === this.lastBucket && this.envRT) {
      scene.environmentIntensity = opts.isDay
        ? OUTDOOR_IBL_INTENSITY_DAY
        : OUTDOOR_IBL_INTENSITY_NIGHT
      return
    }
    this.lastBucket = bucket
    this.rebuild(scene, colors, opts.isDay)
  }

  setEnabled(on: boolean, scene: THREE.Scene): void {
    this.enabled = on
    if (!on) this.clear(scene)
  }

  dispose(scene?: THREE.Scene): void {
    if (scene) this.clear(scene)
    this.envRT?.dispose()
    this.envRT = null
    this.pmrem.dispose()
  }

  private clear(scene: THREE.Scene): void {
    if (scene.environment === this.envRT?.texture) {
      scene.environment = null
    }
    scene.environmentIntensity = 1
    this.envRT?.dispose()
    this.envRT = null
    this.lastBucket = -1
  }

  private rebuild(scene: THREE.Scene, colors: OutdoorIblColors, isDay: boolean): void {
    // Disposable probe scene — hemi + soft equator ambient only (no geometry thrash).
    const probe = new THREE.Scene()
    const hemi = new THREE.HemisphereLight(colors.sky, colors.ground, isDay ? 1.0 : 0.75)
    probe.add(hemi)
    const eq = new THREE.AmbientLight(colors.equator, isDay ? 0.35 : 0.45)
    probe.add(eq)
    // Large ground plane for bounce in PMREM (cheap).
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(40, 40),
      new THREE.MeshStandardMaterial({
        color: colors.ground,
        roughness: 1,
        metalness: 0,
        side: THREE.DoubleSide
      })
    )
    ground.rotation.x = -Math.PI / 2
    ground.position.y = -0.5
    probe.add(ground)
    const skyDome = new THREE.Mesh(
      new THREE.SphereGeometry(20, 16, 12),
      new THREE.MeshBasicMaterial({
        color: colors.sky,
        side: THREE.BackSide,
        depthWrite: false
      })
    )
    probe.add(skyDome)

    const prev = this.envRT
    try {
      // sigma ~0.04 — soft outdoor blur (Explorer ambient, not mirror).
      this.envRT = this.pmrem.fromScene(probe, 0.04, 0.1, 100)
      scene.environment = this.envRT.texture
      scene.environmentIntensity = isDay ? OUTDOOR_IBL_INTENSITY_DAY : OUTDOOR_IBL_INTENSITY_NIGHT
    } catch (err) {
      console.warn('[environment] outdoor IBL PMREM failed', err)
    } finally {
      ground.geometry.dispose()
      ;(ground.material as THREE.Material).dispose()
      skyDome.geometry.dispose()
      ;(skyDome.material as THREE.Material).dispose()
      prev?.dispose()
    }
  }
}
