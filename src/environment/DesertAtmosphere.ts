/**
 * Desert dust storm particles + lightweight rolling tumbleweeds.
 * Spans the infinite outer footprint (forest-scale); optional across scene parcels.
 */
import * as THREE from 'three'
import type { SceneDesertConfig } from '../dcl/content/types'
import { PARCEL_SIZE } from '../dcl/content/types'
import { resolveDesertSettings, type ResolvedDesertSettings } from './desertDefaults'

type Tumbleweed = {
  mesh: THREE.Mesh
  speed: number
  spin: number
  radius: number
  phase: number
}

export type DesertAtmosphereFootprint = {
  widthM: number
  depthM: number
  originX: number
  originZ: number
  /** Deployed scene parcel keys `"x,y"` — used when acrossParcels is false. */
  sceneParcelKeys?: ReadonlySet<string>
  baseParcelX?: number
  baseParcelY?: number
}

export class DesertAtmosphere {
  readonly group = new THREE.Group()
  private dust: THREE.Points | null = null
  private dustGeo: THREE.BufferGeometry | null = null
  private dustMat: THREE.PointsMaterial | null = null
  private dustPositions: Float32Array | null = null
  private tumbleweeds: Tumbleweed[] = []
  private settings: ResolvedDesertSettings = resolveDesertSettings()
  private elapsed = 0
  private mounted = false
  private footprint: DesertAtmosphereFootprint = {
    widthM: 64,
    depthM: 64,
    originX: 0,
    originZ: 0
  }

  constructor() {
    this.group.name = 'DesertAtmosphere'
  }

  static create(
    initial?: SceneDesertConfig | null,
    footprint?: DesertAtmosphereFootprint
  ): DesertAtmosphere {
    const d = new DesertAtmosphere()
    if (footprint) d.footprint = footprint
    d.applySettings(initial)
    return d
  }

  setFootprint(fp: DesertAtmosphereFootprint): void {
    this.footprint = fp
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

  applySettings(raw?: SceneDesertConfig | null): void {
    this.settings = resolveDesertSettings(raw)
    this.rebuildDust()
    this.rebuildTumbleweeds()
  }

  applyToScene(scene: THREE.Scene): void {
    const s = this.settings
    if (s.haze > 0.0001) {
      scene.fog = new THREE.FogExp2(new THREE.Color(s.sandColor).getHex(), s.haze)
    } else if (scene.fog instanceof THREE.FogExp2) {
      scene.fog = null
    }
  }

  update(delta: number): void {
    this.elapsed += delta
    const s = this.settings
    if (this.dust && this.dustPositions && s.dustStorm) {
      const pos = this.dustPositions
      const wind = 4 + s.dustIntensity * 10
      const w = this.footprint.widthM
      const d = this.footprint.depthM
      const ox = this.footprint.originX
      const oz = this.footprint.originZ
      for (let i = 0; i < pos.length; i += 3) {
        pos[i] += wind * delta * (0.6 + (i % 7) * 0.05)
        pos[i + 1] += Math.sin(this.elapsed * 2 + i) * 0.15 * delta
        pos[i + 2] += wind * 0.35 * delta
        if (pos[i]! > ox + w + 8) pos[i] = ox - 8
        if (pos[i + 2]! > oz + d + 8) pos[i + 2] = oz - 8
        if (pos[i + 1]! < 0.3) pos[i + 1] = 0.5 + Math.random() * 6
        if (pos[i + 1]! > 14) pos[i + 1] = 1
      }
      this.dustGeo!.attributes.position!.needsUpdate = true
    }

    for (const t of this.tumbleweeds) {
      t.mesh.position.x += t.speed * delta
      t.mesh.position.z += Math.sin(this.elapsed * 0.7 + t.phase) * t.speed * 0.25 * delta
      t.mesh.rotation.z -= (t.speed / Math.max(0.2, t.radius)) * delta
      t.mesh.rotation.y += t.spin * delta
      const maxX = this.footprint.originX + this.footprint.widthM + 6
      if (t.mesh.position.x > maxX) {
        const p = this.sampleSpawnXZ()
        t.mesh.position.x = p.x
        t.mesh.position.z = p.z
      }
    }
  }

  dispose(): void {
    this.clearDust()
    this.clearTumbleweeds()
    this.group.removeFromParent()
    this.mounted = false
  }

  /** True if world XZ lies on a deployed scene parcel. */
  private isOnSceneParcel(worldX: number, worldZ: number): boolean {
    const keys = this.footprint.sceneParcelKeys
    if (!keys?.size) return false
    const bx = this.footprint.baseParcelX ?? 0
    const by = this.footprint.baseParcelY ?? 0
    const px = bx + Math.floor(worldX / PARCEL_SIZE)
    const py = by + Math.floor(worldZ / PARCEL_SIZE)
    return keys.has(`${px},${py}`)
  }

  /**
   * Random XZ in the infinite footprint.
   * When acrossParcels is false, reject samples that land on scene parcels.
   */
  private sampleSpawnXZ(): { x: number; z: number } {
    const ox = this.footprint.originX
    const oz = this.footprint.originZ
    const w = this.footprint.widthM
    const d = this.footprint.depthM
    const allowParcels = this.settings.acrossParcels
    for (let attempt = 0; attempt < 24; attempt++) {
      const x = ox + Math.random() * w
      const z = oz + Math.random() * d
      if (allowParcels || !this.isOnSceneParcel(x, z)) return { x, z }
    }
    // Fallback: push outside parcel AABB roughly
    return { x: ox + Math.random() * w, z: oz + Math.random() * d }
  }

  private rebuildDust(): void {
    this.clearDust()
    const s = this.settings
    if (!s.dustStorm || s.dustIntensity <= 0.01) return

    // Scale particle count with footprint (horizon storms need more points).
    const area = Math.max(1, this.footprint.widthM * this.footprint.depthM)
    const areaFactor = Math.min(3.5, Math.sqrt(area) / 120)
    const count = Math.floor((500 + s.dustIntensity * 2800) * areaFactor)
    const positions = new Float32Array(count * 3)
    let written = 0
    for (let i = 0; i < count; i++) {
      const p = this.sampleSpawnXZ()
      positions[written * 3] = p.x
      positions[written * 3 + 1] = 0.4 + Math.random() * 10
      positions[written * 3 + 2] = p.z
      written++
    }
    this.dustPositions = positions
    this.dustGeo = new THREE.BufferGeometry()
    this.dustGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    this.dustMat = new THREE.PointsMaterial({
      color: new THREE.Color(s.sandColor).lerp(new THREE.Color(0x8a7040), 0.35),
      size: 0.35 + s.dustIntensity * 0.55,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.25 + s.dustIntensity * 0.45,
      depthWrite: false,
      blending: THREE.NormalBlending
    })
    this.dust = new THREE.Points(this.dustGeo, this.dustMat)
    this.dust.frustumCulled = false
    this.dust.name = 'DesertDust'
    this.group.add(this.dust)
  }

  private clearDust(): void {
    if (this.dust) {
      this.group.remove(this.dust)
      this.dust = null
    }
    this.dustGeo?.dispose()
    this.dustGeo = null
    this.dustMat?.dispose()
    this.dustMat = null
    this.dustPositions = null
  }

  private rebuildTumbleweeds(): void {
    this.clearTumbleweeds()
    const s = this.settings
    if (!s.tumbleweeds || s.tumbleweedCount <= 0) return

    const geo = new THREE.SphereGeometry(1, 8, 6)
    const mat = new THREE.MeshStandardMaterial({
      color: 0x8b6914,
      roughness: 0.95,
      metalness: 0.05
    })
    for (let i = 0; i < s.tumbleweedCount; i++) {
      const radius = 0.25 + Math.random() * 0.45
      const mesh = new THREE.Mesh(geo, mat)
      mesh.scale.setScalar(radius)
      const p = this.sampleSpawnXZ()
      mesh.position.set(p.x, radius, p.z)
      mesh.castShadow = true
      this.group.add(mesh)
      this.tumbleweeds.push({
        mesh,
        speed: 1.2 + Math.random() * 2.8,
        spin: 0.8 + Math.random() * 1.5,
        radius,
        phase: Math.random() * Math.PI * 2
      })
    }
  }

  private clearTumbleweeds(): void {
    for (const t of this.tumbleweeds) {
      this.group.remove(t.mesh)
    }
    if (this.tumbleweeds[0]) {
      this.tumbleweeds[0].mesh.geometry.dispose()
      const m = this.tumbleweeds[0].mesh.material
      if (!Array.isArray(m)) m.dispose()
    }
    this.tumbleweeds = []
  }
}
