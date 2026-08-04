import * as THREE from 'three'
import { applyAvatarToonShading } from '../avatar/materials'
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
  /** Rendered XZ half-extent (m), scale cap applied — sizes the follow slot. */
  halfExtentXZ = 0.3
  private mixer: THREE.AnimationMixer | null = null
  private actions = new Map<string, THREE.AnimationAction>()
  private clipNames: string[] = []
  private currentAnim: PetAnimState | null = null
  private currentClipName: string | null = null
  private category: PetCategory = 'walking'
  private animClipMap: PetAnimClipMap | null = null
  private previewClip: string | null = null
  /** Wall-clock when settings preview must release the mixer back to loco. */
  private previewUntilMs = 0
  private previewTimer: ReturnType<typeof setTimeout> | null = null
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

  /** True while settings Play owns the AnimationMixer. */
  isPreviewLocked(): boolean {
    return !!this.previewClip && performance.now() < this.previewUntilMs
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
    // Do not touch an active settings preview lock.
    if (!this.isPreviewLocked()) {
      this.currentAnim = null
      this.currentClipName = null
    }
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
        // Skinned meshes: raw geometry bounds lie whenever the rig carries the
        // real transform (0.01-unit exports) or the positions are quantized
        // (KHR_mesh_quantization folds dequant into the IBMs). The skeleton-
        // aware SkinnedMesh.computeBoundingBox() reports true posed bounds.
        const skinned = mesh as THREE.SkinnedMesh
        let b: THREE.Box3
        if (skinned.isSkinnedMesh) {
          skinned.computeBoundingBox()
          if (!skinned.boundingBox) return
          b = skinned.boundingBox.clone()
        } else {
          mesh.geometry.computeBoundingBox()
          if (!mesh.geometry.boundingBox) return
          b = mesh.geometry.boundingBox.clone()
        }
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
      let capScale = 1
      if (maxDim > 2.5) {
        capScale = 2.5 / maxDim
        scene.scale.multiplyScalar(capScale)
      }
      // Rendered footprint — PetFollow widens the side slot for big pets so an
      // elephant's ear doesn't share space with the owner's arm.
      this.halfExtentXZ = (Math.max(size.x, size.z) / 2) * capScale

      // Pets live beside toon-shaded avatars in a flat-lit world; raw PBR
      // renders them muddy-dark by comparison. Same banded matte treatment
      // as avatars (honors the same quality toggle / URL flags).
      applyAvatarToonShading(scene)

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
    // Settings Play owns the mixer — follow must not overwrite weights mid-preview.
    if (this.isPreviewLocked()) return
    if (this.previewClip) this.stopClipPreview()
    this.applyAnim(pose.anim)
  }

  applyAnim(anim: PetAnimState): void {
    if (!this.mixer || this.actions.size === 0) return
    if (this.isPreviewLocked()) return
    const now = performance.now()
    const sameState = this.currentAnim === anim
    const canReroll =
      sameState &&
      (anim === 'idle' || anim === 'afk' || anim === 'sit') &&
      now - this.lastStateEnterMs > IDLE_REROLL_MS
    if (sameState && !canReroll) {
      // Heal dead mixer stuck on the same band after thrash / exclusive handoff.
      // Without this, early-return leaves weight ~0 forever → bind pose in "real mode".
      if (this.isCurrentClipHealthy()) return
      // Still mid-fade from a recent re-arm — don't restart every frame.
      if (now - this.lastStateEnterMs < CROSSFADE * 1000 + 120) return
    }
    // Let the running fade finish before honouring the next band change; the
    // caller re-asserts the pose every frame, so nothing is lost by waiting.
    // Skip dwell when healing a dead clip so we can re-arm immediately.
    if (
      !sameState &&
      this.currentAnim &&
      this.isCurrentClipHealthy() &&
      now - this.lastStateEnterMs < MIN_STATE_DWELL_MS
    ) {
      return
    }

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

  /**
   * Settings-panel track preview — hard-locks the mixer so follow/loco cannot
   * steal weights until the clip finishes (or stopClipPreview).
   */
  playClipPreview(clipName: string): boolean {
    if (!this.mixer || this.actions.size === 0 || this.disposed) return false
    const resolved = this.resolveActionName(clipName)
    if (!resolved) {
      console.warn(`[pets] preview clip not found · “${clipName}” (have ${this.clipNames.length})`)
      return false
    }
    if (this.previewTimer) {
      clearTimeout(this.previewTimer)
      this.previewTimer = null
    }
    const clip = this.actions.get(resolved)?.getClip()
    const ms = Math.min(Math.max((clip?.duration ?? 2) * 1000, 1200), 10_000)
    this.previewClip = resolved
    this.previewUntilMs = performance.now() + ms
    this.currentAnim = null
    this.currentClipName = resolved
    this.lastStateEnterMs = performance.now()
    // Hard takeover — no crossfade. fadeIn left total weight near 0 under follow thrash.
    this.playClipExclusive(resolved)
    this.root.visible = true
    this.previewTimer = setTimeout(() => {
      this.previewTimer = null
      if (this.previewClip === resolved) this.stopClipPreview()
    }, ms)
    return true
  }

  stopClipPreview(): void {
    if (this.previewTimer) {
      clearTimeout(this.previewTimer)
      this.previewTimer = null
    }
    if (!this.previewClip && this.previewUntilMs === 0) return
    this.previewClip = null
    this.previewUntilMs = 0
    this.currentAnim = null
    this.currentClipName = null
    // Exclusive re-arm — crossfade after playClipExclusive often left total weight ~0.
    if (!this.disposed && this.mixer) {
      const pool = this.resolveClipPool('idle')
      const clip = pool[0]
      if (clip) {
        this.playClipExclusive(clip)
        this.currentAnim = 'idle'
        this.currentClipName = clip
        this.lastStateEnterMs = performance.now()
      }
    }
  }

  update(dt: number): void {
    if (this.previewClip && performance.now() >= this.previewUntilMs) {
      this.stopClipPreview()
    }
    this.mixer?.update(dt)
    // Mixer may write tracks on the GLB root; export offset lives on facePivot only.
    this.facePivot.rotation.set(0, this.meshYawOffsetRad, 0)
  }

  dispose(): void {
    this.disposed = true
    this.loadToken++
    if (this.previewTimer) {
      clearTimeout(this.previewTimer)
      this.previewTimer = null
    }
    this.previewClip = null
    this.previewUntilMs = 0
    this.clearMesh()
    this.root.removeFromParent()
  }

  /**
   * Exclusive clip: stop every other action, snap target to full weight.
   * Used by settings preview so the skin never sits in a half-faded bind pose.
   */
  private playClipExclusive(clipName: string): void {
    const next = this.actions.get(clipName)
    if (!next || !this.mixer) return
    for (const [name, action] of this.actions) {
      if (name === clipName) continue
      action.stop()
      action.enabled = false
      action.setEffectiveWeight(0)
    }
    next.enabled = true
    next.paused = false
    next.reset()
    next.setEffectiveTimeScale(1)
    next.setEffectiveWeight(1)
    next.play()
    // Apply first frame immediately so the pose isn't empty until the next tick.
    this.mixer.update(0)
  }

  /** True when the active loco clip is actually driving the skin. */
  private isCurrentClipHealthy(): boolean {
    if (!this.currentClipName) return false
    const action = this.actions.get(this.currentClipName)
    if (!action) return false
    return action.enabled && !action.paused && action.isRunning() && action.getEffectiveWeight() > 0.5
  }

  private totalActiveWeight(exceptClip?: string): number {
    let w = 0
    for (const [name, action] of this.actions) {
      if (exceptClip && name === exceptClip) continue
      w += Math.max(0, action.getEffectiveWeight())
    }
    return w
  }

  private crossfadeToClip(clipName: string): void {
    const next = this.actions.get(clipName)
    if (!next || !this.mixer) return

    // Already solidly on this clip — don't restart (would flash bind pose).
    if (
      this.currentClipName === clipName &&
      next.enabled &&
      !next.paused &&
      next.isRunning() &&
      next.getEffectiveWeight() > 0.85
    ) {
      return
    }

    const others = this.totalActiveWeight(clipName)
    const selfW = next.getEffectiveWeight()
    // Cold mixer / post-preview residue → hard snap (same path as settings Play).
    // fadeIn from 0 with nothing else contributing left skinned pets in bind pose.
    if (others < 0.08 && selfW < 0.08) {
      this.playClipExclusive(clipName)
      return
    }

    // Fade every non-target action out. Relying only on currentClipName left
    // stale weights after setAnimClipMap / preview (currentClipName cleared) so
    // total influence stayed ~0 → bind pose forever ("local animations dead").
    for (const [name, action] of this.actions) {
      if (name === clipName) continue
      if (action.getEffectiveWeight() > 0.001 || action.isRunning()) {
        action.enabled = true
        action.paused = false
        action.fadeOut(CROSSFADE)
      } else {
        action.stop()
        action.enabled = false
        action.setEffectiveWeight(0)
      }
    }
    next.enabled = true
    next.paused = false
    next.setEffectiveTimeScale(1)
    // Restart from the beginning so band changes re-arm the clip.
    next.reset()
    next.setEffectiveWeight(0)
    next.play()
    next.fadeIn(CROSSFADE)
    // First skin sample this frame (avoid one-frame bind pose).
    this.mixer.update(0)
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
