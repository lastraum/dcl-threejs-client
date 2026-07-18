/**
 * Space biome atmosphere: void background, star points, soft fog, rim light.
 * Shared by terrain editor preview and play-client EnvironmentSystem.
 */
import * as THREE from 'three'
import type { SceneSpaceConfig } from '../dcl/content/types'
import { resolveSpaceSettings, type ResolvedSpaceSettings } from './spaceSkyDefaults'

const MAX_STARS = 6000
const STAR_RADIUS = 420

export class SpaceSkyField {
  readonly group = new THREE.Group()
  private stars: THREE.Points | null = null
  private starGeo: THREE.BufferGeometry | null = null
  private starMat: THREE.PointsMaterial | null = null
  private rim: THREE.DirectionalLight | null = null
  private hemi: THREE.HemisphereLight | null = null
  private settings: ResolvedSpaceSettings = resolveSpaceSettings()
  private elapsed = 0
  private mounted = false

  constructor() {
    this.group.name = 'SpaceSkyField'
  }

  static create(initial?: SceneSpaceConfig | null): SpaceSkyField {
    const field = new SpaceSkyField()
    field.applySettings(initial)
    return field
  }

  mount(scene: THREE.Scene): void {
    if (this.mounted) return
    scene.add(this.group)
    this.mounted = true
    this.applyToScene(scene)
  }

  unmount(scene: THREE.Scene): void {
    if (!this.mounted) return
    scene.remove(this.group)
    this.mounted = false
    if (scene.fog instanceof THREE.FogExp2) scene.fog = null
  }

  applySettings(raw?: SceneSpaceConfig | null): void {
    this.settings = resolveSpaceSettings(raw)
    this.rebuildStars()
    this.ensureLights()
    this.syncLights()
  }

  /** Call when scene background / fog should refresh (after mount or settings). */
  applyToScene(scene: THREE.Scene): void {
    const s = this.settings
    const sky = new THREE.Color(s.skyColor)
    const nebula = new THREE.Color(s.nebulaColor)
    // Mix nebula into void for a richer deep-space plate.
    sky.lerp(nebula, 0.28)
    scene.background = sky

    if (s.fogDensity > 0.0001) {
      const fogCol = sky.clone().lerp(nebula, 0.45)
      scene.fog = new THREE.FogExp2(fogCol.getHex(), s.fogDensity)
    } else {
      scene.fog = null
    }
    this.syncLights()
  }

  update(delta: number, camera?: THREE.Camera): void {
    this.elapsed += delta
    if (camera) {
      this.group.position.copy(camera.position)
    }
    // Soft twinkle via size oscillation (cheap, no GPU shader rebuild).
    if (this.starMat && this.settings.stars && this.settings.twinkle > 0) {
      const t = this.elapsed * this.settings.twinkle
      const pulse = 0.85 + 0.15 * Math.sin(t * 1.7)
      this.starMat.size = Math.max(0.4, 1.6 * this.settings.starBrightness * pulse)
      this.starMat.opacity = Math.min(1, 0.75 + 0.25 * Math.sin(t * 0.9 + 1.2))
      this.starMat.needsUpdate = true
    }
  }

  dispose(): void {
    this.clearStars()
    if (this.rim) {
      this.rim.removeFromParent()
      this.rim = null
    }
    if (this.hemi) {
      this.hemi.removeFromParent()
      this.hemi = null
    }
    this.group.removeFromParent()
    this.mounted = false
  }

  private ensureLights(): void {
    if (!this.hemi) {
      this.hemi = new THREE.HemisphereLight(0x6ecbff, 0x1a0a3a, 0.35)
      this.hemi.name = 'SpaceHemi'
      this.group.add(this.hemi)
    }
    if (!this.rim) {
      this.rim = new THREE.DirectionalLight(0x6ecbff, 0.85)
      this.rim.name = 'SpaceRim'
      this.rim.position.set(-80, 40, 120)
      this.group.add(this.rim)
      this.group.add(this.rim.target)
      this.rim.target.position.set(0, 0, 0)
    }
  }

  private syncLights(): void {
    const s = this.settings
    if (this.hemi) {
      this.hemi.color.set(s.rimColor)
      this.hemi.groundColor.set(s.nebulaColor)
      this.hemi.intensity = s.ambient
    }
    if (this.rim) {
      this.rim.color.set(s.rimColor)
      this.rim.intensity = s.rimIntensity
    }
  }

  private rebuildStars(): void {
    this.clearStars()
    const s = this.settings
    if (!s.stars || s.starDensity <= 0.001) return

    const count = Math.max(200, Math.floor(MAX_STARS * s.starDensity))
    const positions = new Float32Array(count * 3)
    const colors = new Float32Array(count * 3)
    const sky = new THREE.Color(s.skyColor)
    const nebula = new THREE.Color(s.nebulaColor)
    const white = new THREE.Color(0xffffff)
    const cool = new THREE.Color(s.rimColor)

    for (let i = 0; i < count; i++) {
      // Fibonacci-ish sphere distribution with jitter.
      const u = Math.random()
      const v = Math.random()
      const theta = 2 * Math.PI * u
      const phi = Math.acos(2 * v - 1)
      const r = STAR_RADIUS * (0.92 + Math.random() * 0.08)
      const sinP = Math.sin(phi)
      positions[i * 3] = r * sinP * Math.cos(theta)
      positions[i * 3 + 1] = r * Math.cos(phi)
      positions[i * 3 + 2] = r * sinP * Math.sin(theta)

      // Mix: mostly white/cool, some nebula-tinted sparkles.
      const c = white.clone()
      if (Math.random() < 0.18) c.lerp(cool, 0.55)
      else if (Math.random() < 0.12) c.lerp(nebula, 0.4)
      else c.lerp(sky, 0.05)
      const bright = (0.55 + Math.random() * 0.45) * s.starBrightness
      colors[i * 3] = Math.min(1, c.r * bright)
      colors[i * 3 + 1] = Math.min(1, c.g * bright)
      colors[i * 3 + 2] = Math.min(1, c.b * bright)
    }

    this.starGeo = new THREE.BufferGeometry()
    this.starGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.starGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3))

    this.starMat = new THREE.PointsMaterial({
      size: 1.6 * s.starBrightness,
      sizeAttenuation: false,
      vertexColors: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })

    this.stars = new THREE.Points(this.starGeo, this.starMat)
    this.stars.frustumCulled = false
    this.stars.name = 'SpaceStars'
    this.group.add(this.stars)
  }

  private clearStars(): void {
    if (this.stars) {
      this.group.remove(this.stars)
      this.stars = null
    }
    this.starGeo?.dispose()
    this.starGeo = null
    this.starMat?.dispose()
    this.starMat = null
  }
}
