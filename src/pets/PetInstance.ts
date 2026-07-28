import * as THREE from 'three'
import { syncGltfInstanceRenderState } from '../collision/gltfRenderMeshes'
import { PET_CATEGORY_CONFIG } from './petCategories'
import { countMappedMaterials, parsePetGlbBytes } from './parsePetGlb'
import type { PetAnimClipMap, PetAnimState, PetCategory, PetPose } from './types'

const CROSSFADE = 0.2
/**
 * Minimum time in a band before another switch is allowed (ms).
 *
 * Follow speed is recomputed per frame and jitters across the band thresholds.
 * Without this, a new crossfade starts every frame, no action ever reaches full
 * weight, and a skinned mesh with ~zero total influence snaps to its bind pose.
 * Must exceed CROSSFADE so each fade can finish.
 */
const MIN_STATE_DWELL_MS = 260
/** Re-roll random clip while staying in idle/afk (ms). */
const IDLE_REROLL_MS = 12_000

/**
 * Hierarchy:
 *   root          — position + locomotion yaw (leash / travel)
 *     facePivot   — fixed export correction (meshYawOffsetDeg); never touched by pose travel
 *       model     — GLB scene (anim clips may write local rotations here safely)
 */
export class PetInstance {
  readonly root = new THREE.Group()
  /** Holds export face offset so AnimationMixer / loco never overwrite it. */
  private readonly facePivot = new THREE.Group()
  private mixer: THREE.AnimationMixer | null = null
  private actions = new Map<string, THREE.AnimationAction>()
  private clipNames: string[] = []
  private currentAnim: PetAnimState | null = null
  private currentClipName: string | null = null
  private category: PetCategory = 'walking'
  private animClipMap: PetAnimClipMap | null = null
  private previewClip: string | null = null
  private lastStateEnterMs = 0
  /** Extra Y on facePivot (radians) — export fix, not locomotion yaw. */
  private meshYawOffsetRad = 0
  private disposed = false
  private meshReady = false
  private loadToken = 0

  constructor() {
    this.root.name = 'PetInstance'
    this.facePivot.name = 'PetFacePivot'
    this.root.add(this.facePivot)
    this.root.visible = false
  }

  get isReady(): boolean {
    return this.meshReady && !this.disposed
  }

  getClipNames(): string[] {
    return [...this.clipNames]
  }

  setCategory(category: PetCategory): void {
    this.category = category
  }

  /** Degrees. 180 flips models that export facing the wrong way. */
  setMeshYawOffsetDeg(deg: number): void {
    this.meshYawOffsetRad = (deg * Math.PI) / 180
    this.facePivot.rotation.set(0, this.meshYawOffsetRad, 0)
  }

  /** User clip → anim-state pools. Empty / null falls back to default aliases. */
  setAnimClipMap(map: PetAnimClipMap | null | undefined): void {
    this.animClipMap = map && Object.keys(map).length ? { ...map } : null
    // Force re-resolve on next pose so new map applies immediately.
    this.currentAnim = null
    this.currentClipName = null
  }

  async loadFromBytes(bytes: ArrayBuffer, category: PetCategory): Promise<void> {
    if (this.disposed) return
    const token = ++this.loadToken
    this.clearMesh()
    this.category = category
    this.previewClip = null
    // Keep face offset on the pivot across reloads.
    this.facePivot.rotation.set(0, this.meshYawOffsetRad, 0)

    try {
      // Data-URI rewrite avoids blob: texture load failures after DPET transfer.
      const gltf = await parsePetGlbBytes(bytes)
      if (this.disposed || token !== this.loadToken) {
        disposeObject(gltf.scene)
        return
      }

      const scene = gltf.scene
      scene.name = scene.name || 'PetModel'
      // Hide DCL `*_collider` hulls (ancestry — Cube under HummingBird_collider).
      syncGltfInstanceRenderState(scene)
      preparePetMaterials(scene)
      const maps = countMappedMaterials(scene)
      if (maps.meshes > 0 && maps.withMap === 0) {
        console.warn('[pets] loaded pet has no material maps — may appear white')
      }
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (mesh.isMesh && mesh.visible) {
          mesh.castShadow = true
          mesh.receiveShadow = true
          mesh.frustumCulled = true
        }
      })

      // Center XZ on origin; keep feet near y=0 for walking pets (visible meshes only).
      const box = new THREE.Box3()
      box.makeEmpty()
      scene.updateMatrixWorld(true)
      scene.traverse((obj) => {
        const mesh = obj as THREE.Mesh
        if (!mesh.isMesh || !mesh.visible || !mesh.geometry) return
        mesh.geometry.computeBoundingBox()
        if (!mesh.geometry.boundingBox) return
        const b = mesh.geometry.boundingBox.clone()
        b.applyMatrix4(mesh.matrixWorld)
        box.union(b)
      })
      if (box.isEmpty()) box.setFromObject(scene)
      const size = new THREE.Vector3()
      const center = new THREE.Vector3()
      box.getSize(size)
      box.getCenter(center)
      scene.position.x -= center.x
      scene.position.z -= center.z
      scene.position.y -= box.min.y
      // Never bake export yaw into the model — facePivot owns that.
      scene.rotation.set(0, 0, 0)

      // Soft scale cap so huge uploads don't fill the plaza.
      const maxDim = Math.max(size.x, size.y, size.z, 0.01)
      if (maxDim > 2.5) {
        const s = 2.5 / maxDim
        scene.scale.multiplyScalar(s)
      }

      this.facePivot.add(scene)
      this.mixer = new THREE.AnimationMixer(scene)
      this.actions.clear()
      this.clipNames = []
      for (const clip of gltf.animations ?? []) {
        if (!clip?.name) continue
        this.clipNames.push(clip.name)
        const action = this.mixer.clipAction(clip)
        action.enabled = true
        action.setEffectiveWeight(0)
        action.play()
        this.actions.set(clip.name, action)
      }
      this.meshReady = true
      this.root.visible = true
      this.currentAnim = null
      this.currentClipName = null
      this.applyAnim('idle')
    } catch (err) {
      console.warn('[pets] failed to load pet GLB', err)
      this.meshReady = false
      this.root.visible = false
    }
  }

  /**
   * Pose in Three.js display space.
   * root = travel/owner facing; facePivot = fixed export correction.
   */
  applyPose(pose: PetPose): void {
    this.root.position.set(pose.x, pose.y, pose.z)
    this.root.rotation.set(0, pose.yaw, 0)
    // Re-assert every frame so nothing can strip the export fix.
    this.facePivot.rotation.set(0, this.meshYawOffsetRad, 0)
    // Loco pose cancels edit-panel preview.
    if (this.previewClip) this.previewClip = null
    this.applyAnim(pose.anim)
  }

  applyAnim(anim: PetAnimState): void {
    if (!this.mixer || this.actions.size === 0) return
    const now = performance.now()
    const sameState = this.currentAnim === anim
    const canReroll =
      sameState &&
      (anim === 'idle' || anim === 'afk' || anim === 'sit') &&
      now - this.lastStateEnterMs > IDLE_REROLL_MS
    if (sameState && !canReroll) return
    // Let the running fade finish before honouring the next band change; the
    // caller re-asserts the pose every frame, so nothing is lost by waiting.
    if (!sameState && this.currentAnim && now - this.lastStateEnterMs < MIN_STATE_DWELL_MS) return

    const pool = this.resolveClipPool(anim)
    if (!pool.length) return
    let clipName = pool[0]!
    if (pool.length > 1) {
      // Avoid immediate re-pick of the same clip when re-rolling idle/afk.
      const candidates =
        canReroll && this.currentClipName
          ? pool.filter((n) => n !== this.currentClipName)
          : pool
      const pickFrom = candidates.length ? candidates : pool
      clipName = pickFrom[Math.floor(Math.random() * pickFrom.length)]!
    }
    this.crossfadeToClip(clipName)
    this.currentAnim = anim
    this.currentClipName = clipName
    this.lastStateEnterMs = now
  }

  /** Play a named clip once for settings preview (local only). */
  playClipPreview(clipName: string): boolean {
    if (!this.mixer || this.actions.size === 0) return false
    const resolved = this.resolveActionName(clipName)
    if (!resolved) return false
    this.previewClip = resolved
    this.currentAnim = null
    this.currentClipName = resolved
    this.crossfadeToClip(resolved)
    return true
  }

  stopClipPreview(): void {
    if (!this.previewClip) return
    this.previewClip = null
    this.currentAnim = null
    this.currentClipName = null
    this.applyAnim('idle')
  }

  update(dt: number): void {
    this.mixer?.update(dt)
    // Mixer may write tracks on the GLB root; export offset lives on facePivot only.
    this.facePivot.rotation.set(0, this.meshYawOffsetRad, 0)
  }

  dispose(): void {
    this.disposed = true
    this.loadToken++
    this.clearMesh()
    this.root.removeFromParent()
  }

  private crossfadeToClip(clipName: string): void {
    const next = this.actions.get(clipName)
    if (!next) return
    const prev = this.currentClipName ? this.actions.get(this.currentClipName) : null
    // crossFadeFrom only schedules weights — it never re-arms a stopped action.
    // An action that is disabled, paused or not running contributes nothing, and
    // once the outgoing clip has faded out the mesh drops to its bind pose.
    next.enabled = true
    next.paused = false
    next.setEffectiveTimeScale(1)
    if (!next.isRunning()) next.play()
    if (prev && prev !== next) {
      prev.crossFadeTo(next, CROSSFADE, false)
    } else {
      next.reset().fadeIn(CROSSFADE)
    }
    next.setEffectiveWeight(1)
  }

  private resolveActionName(name: string): string | null {
    if (this.actions.has(name)) return name
    const lower = name.toLowerCase()
    for (const n of this.clipNames) {
      if (n.toLowerCase() === lower) return n
    }
    return null
  }

  /** Clip pool for an anim state — user map first, then default aliases. */
  private resolveClipPool(anim: PetAnimState): string[] {
    const resolved: string[] = []
    const push = (name: string) => {
      const hit = this.resolveActionName(name)
      if (hit && !resolved.includes(hit)) resolved.push(hit)
    }

    const custom = this.animClipMap?.[anim]
    if (custom?.length) {
      for (const n of custom) push(n)
      if (resolved.length) return resolved
    }

    const aliases = PET_CATEGORY_CONFIG[this.category].clipAliases[anim] ?? []
    for (const name of aliases) push(name)

    if (!resolved.length && (anim === 'idle' || anim === 'afk' || anim === 'sit')) {
      for (const n of this.clipNames) {
        if (/idle|hover|stand|afk|sit|sleep|rest/i.test(n)) push(n)
      }
    }
    if (!resolved.length && this.clipNames[0]) push(this.clipNames[0])
    return resolved
  }

  private clearMesh(): void {
    this.mixer?.stopAllAction()
    this.mixer = null
    this.actions.clear()
    this.clipNames = []
    this.currentAnim = null
    this.currentClipName = null
    this.previewClip = null
    this.meshReady = false
    while (this.facePivot.children.length) {
      const child = this.facePivot.children[0]!
      this.facePivot.remove(child)
      disposeObject(child)
    }
  }
}

/** Ensure baseColor/emissive maps use sRGB; keep alpha cutout pets readable. */
function preparePetMaterials(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    mesh.frustumCulled = false
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat) continue
      const std = mat as THREE.MeshStandardMaterial
      mat.visible = true
      std.side = THREE.DoubleSide
      if (std.map) {
        std.map.colorSpace = THREE.SRGBColorSpace
        std.map.needsUpdate = true
      }
      if (std.emissiveMap) {
        std.emissiveMap.colorSpace = THREE.SRGBColorSpace
        std.emissiveMap.needsUpdate = true
      }
      if ('opacity' in std && (std.opacity ?? 1) < 0.02) {
        std.opacity = 1
        std.transparent = false
      }
      std.needsUpdate = true
    }
  })
}

function disposeObject(obj: THREE.Object3D): void {
  obj.traverse((node) => {
    const mesh = node as THREE.Mesh
    if (mesh.isMesh) {
      mesh.geometry?.dispose()
      const mat = mesh.material
      if (Array.isArray(mat)) mat.forEach((m) => m.dispose())
      else mat?.dispose()
    }
  })
}
