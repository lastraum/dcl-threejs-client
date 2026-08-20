import * as THREE from 'three'
import { PMREMGenerator } from 'three'

/**
 * AAA outdoor IBL — low-rate sky probe, not full GI / per-frame PMREM.
 *
 * Explorer bakes the visible skybox → cubemap for ambient reflections. We
 * approximate with a tiny probe from zenit / horizon / nadir (not the muted
 * trilight ambient — that made specular volumes read as dirt). Re-baked only
 * when TOD bucket or sky colors change. scene.environmentIntensity scales
 * contribution.
 */

/** Daytime sky bounce — Explorer cubemap fill. 0.18 crushed wood/water vs locked 10:00. */
export const OUTDOOR_IBL_INTENSITY_DAY = 0.30
/** Night probe — low so moon/hemi own the key; was 0.22 and washed 00:00. */
export const OUTDOOR_IBL_INTENSITY_NIGHT = 0.1

/** Normalized TOD quantized into this many rebuilds per day (AAA: not every frame). */
const TOD_BUCKETS = 12

export type OutdoorIblColors = {
  sky: THREE.Color
  ground: THREE.Color
  equator: THREE.Color
}

const SKY_PROBE_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const SKY_PROBE_FRAG = /* glsl */ `
uniform vec3 uZenit;
uniform vec3 uHorizon;
uniform vec3 uNadir;
varying vec3 vDir;
void main() {
  float y = normalize(vDir).y;
  vec3 col = y >= 0.0
    ? mix(uHorizon, uZenit, pow(clamp(y, 0.0, 1.0), 0.65))
    : mix(uHorizon, uNadir, pow(clamp(-y, 0.0, 1.0), 0.55));
  gl_FragColor = vec4(col, 1.0);
}
`

export class OutdoorIbl {
  private readonly pmrem: PMREMGenerator
  private envRT: THREE.WebGLRenderTarget | null = null
  private lastBucket = -1
  private lastColorKey = ''
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
    const colorKey = `${colors.sky.getHexString()}${colors.ground.getHexString()}${colors.equator.getHexString()}`
    if (!opts.force && bucket === this.lastBucket && colorKey === this.lastColorKey && this.envRT) {
      scene.environmentIntensity = opts.isDay
        ? OUTDOOR_IBL_INTENSITY_DAY
        : OUTDOOR_IBL_INTENSITY_NIGHT
      return
    }
    this.lastBucket = bucket
    this.lastColorKey = colorKey
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
    this.lastColorKey = ''
  }

  private rebuild(scene: THREE.Scene, colors: OutdoorIblColors, isDay: boolean): void {
    // Disposable probe — visible skybox gradient (zenit / horizon / nadir), not a
    // two-color hemi. Explorer bakes the full dome; a flat zenit dome dropped the
    // pink/cyan horizon that tinted rough specular volumes.
    const probe = new THREE.Scene()
    const hemi = new THREE.HemisphereLight(colors.sky, colors.ground, isDay ? 1.0 : 0.75)
    probe.add(hemi)
    const eq = new THREE.AmbientLight(colors.equator, isDay ? 0.55 : 0.5)
    probe.add(eq)
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
    const skyMat = new THREE.ShaderMaterial({
      uniforms: {
        uZenit: { value: colors.sky.clone() },
        uHorizon: { value: colors.equator.clone() },
        uNadir: { value: colors.ground.clone() }
      },
      vertexShader: SKY_PROBE_VERT,
      fragmentShader: SKY_PROBE_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      toneMapped: false
    })
    const skyDome = new THREE.Mesh(new THREE.SphereGeometry(20, 24, 16), skyMat)
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
      skyMat.dispose()
      prev?.dispose()
    }
  }
}
