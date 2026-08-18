import * as THREE from 'three'

const SHARD_COUNT = 28
const HOLD_AFTER_S = 0.35
const FADE_S = 0.45

const _up = new THREE.Vector3(0, 1, 0)
const _dummy = new THREE.Object3D()

/**
 * Obvious ice LINE for `tjs.vfx:ice` — fracture shards erupt along +Z at `speed`.
 * Not the full threejs-vfx IceAbility; silhouette test only.
 */
export class IceLineCast {
  readonly group = new THREE.Group()
  private readonly mesh: THREE.InstancedMesh
  private readonly births: Float32Array
  private readonly offsets: Float32Array
  private readonly laterals: Float32Array
  private readonly heights: Float32Array
  private age = 0
  private done = false

  constructor(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    private readonly range: number,
    private readonly speed: number
  ) {
    this.group.name = 'tjs.vfx:ice'
    this.group.position.copy(origin)
    const dir = direction.clone()
    dir.y = 0
    if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1)
    dir.normalize()
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), dir)

    const geo = new THREE.ConeGeometry(0.22, 1.4, 5)
    geo.translate(0, 0.7, 0)
    const mat = new THREE.MeshStandardMaterial({
      color: 0xbfefff,
      emissive: 0x4ec8ff,
      emissiveIntensity: 1.6,
      roughness: 0.18,
      metalness: 0.08,
      transparent: true,
      opacity: 1
    })
    this.mesh = new THREE.InstancedMesh(geo, mat, SHARD_COUNT)
    this.mesh.frustumCulled = false
    this.mesh.count = SHARD_COUNT
    this.group.add(this.mesh)

    this.births = new Float32Array(SHARD_COUNT)
    this.offsets = new Float32Array(SHARD_COUNT)
    this.laterals = new Float32Array(SHARD_COUNT)
    this.heights = new Float32Array(SHARD_COUNT)
    const travel = Math.max(0.2, this.range / Math.max(1, this.speed))
    for (let i = 0; i < SHARD_COUNT; i++) {
      const u = i / (SHARD_COUNT - 1)
      this.offsets[i] = u * this.range
      this.laterals[i] = (Math.random() * 2 - 1) * (0.15 + u * 0.85)
      this.heights[i] = 0.45 + u * 1.8 + Math.random() * 0.35
      this.births[i] = u * travel
    }
  }

  get finished(): boolean {
    return this.done
  }

  update(dt: number): void {
    if (this.done) return
    this.age += dt
    const travel = Math.max(0.2, this.range / Math.max(1, this.speed))
    const life = travel + HOLD_AFTER_S + FADE_S
    if (this.age >= life) {
      this.done = true
      this.group.visible = false
      return
    }

    const fadeStart = travel + HOLD_AFTER_S
    const fade = this.age < fadeStart ? 1 : 1 - (this.age - fadeStart) / FADE_S
    const mat = this.mesh.material as THREE.MeshStandardMaterial
    mat.opacity = Math.max(0, fade)
    mat.emissiveIntensity = 1.6 * Math.max(0.15, fade)

    for (let i = 0; i < SHARD_COUNT; i++) {
      const born = this.age - this.births[i]!
      if (born < 0) {
        _dummy.scale.setScalar(0)
        _dummy.position.set(0, -10, 0)
      } else {
        const grow = Math.min(1, born / 0.12)
        const h = this.heights[i]! * grow
        _dummy.position.set(this.laterals[i]!, 0, this.offsets[i]!)
        _dummy.scale.set(0.7 + grow * 0.5, h, 0.7 + grow * 0.5)
        _dummy.quaternion.setFromAxisAngle(_up, i * 0.7)
      }
      _dummy.updateMatrix()
      this.mesh.setMatrixAt(i, _dummy.matrix)
    }
    this.mesh.instanceMatrix.needsUpdate = true
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
    this.group.removeFromParent()
  }
}
