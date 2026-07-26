import * as THREE from 'three'
import { syncGltfInstanceRenderState } from '../collision/gltfRenderMeshes'
import { PET_CATEGORY_CONFIG } from './petCategories'
import { countMappedMaterials, parsePetGlbBytes } from './parsePetGlb'
import type { PetAnimState, PetCategory, PetPose } from './types'

const CROSSFADE = 0.2

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
  private category: PetCategory = 'walking'
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

  setCategory(category: PetCategory): void {
    this.category = category
  }

  /** Degrees. 180 flips models that export facing the wrong way. */
  setMeshYawOffsetDeg(deg: number): void {
    this.meshYawOffsetRad = (deg * Math.PI) / 180
    this.facePivot.rotation.set(0, this.meshYawOffsetRad, 0)
  }

  async loadFromBytes(bytes: ArrayBuffer, category: PetCategory): Promise<void> {
    if (this.disposed) return
    const token = ++this.loadToken
    this.clearMesh()
    this.category = category
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
    this.applyAnim(pose.anim)
  }

  applyAnim(anim: PetAnimState): void {
    if (!this.mixer || this.actions.size === 0) return
    if (this.currentAnim === anim) return
    const clipName = this.resolveClip(anim)
    if (!clipName) return
    const next = this.actions.get(clipName)
    if (!next) return

    const prevName = this.currentAnim ? this.resolveClip(this.currentAnim) : null
    const prev = prevName ? this.actions.get(prevName) : null
    if (prev && prev !== next) {
      prev.crossFadeTo(next, CROSSFADE, false)
    } else {
      next.reset().fadeIn(CROSSFADE)
    }
    next.setEffectiveWeight(1)
    this.currentAnim = anim
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

  private resolveClip(anim: PetAnimState): string | null {
    const aliases = PET_CATEGORY_CONFIG[this.category].clipAliases[anim] ?? []
    for (const name of aliases) {
      if (this.actions.has(name)) return name
    }
    const lowerMap = new Map(this.clipNames.map((n) => [n.toLowerCase(), n]))
    for (const name of aliases) {
      const hit = lowerMap.get(name.toLowerCase())
      if (hit) return hit
    }
    for (const n of this.clipNames) {
      if (/idle|hover|stand/i.test(n)) return n
    }
    return this.clipNames[0] ?? null
  }

  private clearMesh(): void {
    this.mixer?.stopAllAction()
    this.mixer = null
    this.actions.clear()
    this.clipNames = []
    this.currentAnim = null
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
