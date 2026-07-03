import * as THREE from 'three'
import { dclToThreePos } from '../bridge/dclTransform'
import { createGltfLoader, sanitizeWearableRoot } from '../avatar/loadWearable'
import { prepareAvatarMaterials } from '../avatar/materials'
import { normalizeWearableWorldScale } from '../avatar/wearableSanitize'
import { parseParcelKey, parcelWorldOrigin } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { bakeStaticMannequinFromRoot } from './bakeAvatarMannequin'
import type { TerrainSceneFootprint } from './terrain/terrainFootprint'

const BASE_MALE_GLB = '/avatar/wearables/BaseMale/BaseMale.glb'

/** Decentraland avatar bounds (m) — reference for UI copy. */
export const EDITOR_AVATAR_SIZE_M = {
  width: 0.75,
  height: 1.75,
  depth: 0.5
} as const

export const EDITOR_AVATAR_SCALE_MIN_PER_PARCEL = 1
export const EDITOR_AVATAR_SCALE_MAX_PER_PARCEL = 256
export const EDITOR_AVATAR_SCALE_DEFAULT_PER_PARCEL = EDITOR_AVATAR_SCALE_MAX_PER_PARCEL

/** Height samples per animation frame while toggling on (keeps UI responsive). */
const PLACEMENT_CHUNK_SIZE = 128

export type AvatarScaleSample = { dclX: number; dclZ: number }

export function avatarScaleGridAxisForCount(countPerParcel: number): number {
  const clamped = clampAvatarScaleCount(countPerParcel)
  return Math.min(PARCEL_SIZE, Math.max(1, Math.ceil(Math.sqrt(clamped))))
}

export function clampAvatarScaleCount(countPerParcel: number): number {
  return Math.min(
    EDITOR_AVATAR_SCALE_MAX_PER_PARCEL,
    Math.max(EDITOR_AVATAR_SCALE_MIN_PER_PARCEL, Math.round(countPerParcel))
  )
}

export function formatAvatarScaleCountLabel(countPerParcel: number): string {
  const count = clampAvatarScaleCount(countPerParcel)
  const axis = avatarScaleGridAxisForCount(count)
  return `${count} (${axis}×${axis})`
}

export function avatarScaleSamplesForFootprint(
  footprint: TerrainSceneFootprint,
  countPerParcel = EDITOR_AVATAR_SCALE_DEFAULT_PER_PARCEL
): AvatarScaleSample[] {
  const count = clampAvatarScaleCount(countPerParcel)
  const cellsPerAxis = avatarScaleGridAxisForCount(count)
  const cellM = PARCEL_SIZE / cellsPerAxis
  const base = parseParcelKey(footprint.baseParcel)
  const samples: AvatarScaleSample[] = []

  for (const key of footprint.parcels) {
    const parcel = parseParcelKey(key)
    const origin = parcelWorldOrigin(parcel, base)
    let placed = 0
    for (let row = 0; row < cellsPerAxis && placed < count; row++) {
      for (let col = 0; col < cellsPerAxis && placed < count; col++) {
        samples.push({
          dclX: origin.x + (col + 0.5) * cellM,
          dclZ: origin.z + (row + 0.5) * cellM
        })
        placed++
      }
    }
  }

  return samples
}

/**
 * Instanced static BaseMale mannequins (bind pose) on a configurable parcel grid (1–256 per parcel).
 * GLB is baked once; placement uses the heightmap (no mesh raycasts).
 */
export class EditorAvatarScaleGuides {
  private readonly group = new THREE.Group()
  private readonly dummy = new THREE.Object3D()
  private readonly scratch = new THREE.Vector3()
  private readonly footprint: TerrainSceneFootprint
  private readonly maxSamples: number
  private samples: AvatarScaleSample[]
  private countPerParcel = EDITOR_AVATAR_SCALE_DEFAULT_PER_PARCEL
  private meshes: THREE.InstancedMesh[] = []
  private visible = false
  private ready = false
  private placementToken = 0

  constructor(
    footprint: TerrainSceneFootprint,
    private readonly sampleSurfaceY: (dclX: number, dclZ: number) => number
  ) {
    this.footprint = footprint
    this.maxSamples = avatarScaleSamplesForFootprint(
      footprint,
      EDITOR_AVATAR_SCALE_MAX_PER_PARCEL
    ).length
    this.samples = avatarScaleSamplesForFootprint(footprint, this.countPerParcel)
    this.group.name = 'editor-avatar-scale-guides'
    this.group.visible = false
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  async initialize(): Promise<void> {
    const loader = createGltfLoader({})
    const gltf = await loader.loadAsync(BASE_MALE_GLB)
    const avatarRoot = gltf.scene
    avatarRoot.name = 'editor-avatar-mannequin-source'
    sanitizeWearableRoot(avatarRoot)
    normalizeWearableWorldScale(avatarRoot, 'body_shape')
    prepareAvatarMaterials(avatarRoot)

    const bakedParts = bakeStaticMannequinFromRoot(avatarRoot)
    if (!bakedParts?.length) throw new Error('BaseMale mannequin bake failed')

    this.dummy.scale.set(0, 0, 0)
    this.dummy.updateMatrix()
    for (const part of bakedParts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, this.maxSamples)
      mesh.frustumCulled = false
      mesh.renderOrder = 10
      for (let i = 0; i < this.maxSamples; i++) {
        mesh.setMatrixAt(i, this.dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      this.group.add(mesh)
      this.meshes.push(mesh)
    }

    this.ready = true
    if (this.visible) void this.placeMarkersChunked()
  }

  getCountPerParcel(): number {
    return this.countPerParcel
  }

  setCountPerParcel(countPerParcel: number): void {
    const next = clampAvatarScaleCount(countPerParcel)
    if (next === this.countPerParcel) return
    this.countPerParcel = next
    this.samples = avatarScaleSamplesForFootprint(this.footprint, this.countPerParcel)
    if (this.visible && this.ready) void this.placeMarkersChunked()
  }

  setVisible(visible: boolean): void {
    this.placementToken++
    this.visible = visible
    this.group.visible = visible
    if (visible && this.ready) void this.placeMarkersChunked()
  }

  getVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    this.placementToken++
    for (const mesh of this.meshes) {
      mesh.geometry.dispose()
      ;(mesh.material as THREE.Material).dispose()
      this.group.remove(mesh)
    }
    this.meshes = []
    this.group.removeFromParent()
    this.ready = false
  }

  /** One heightmap pass per toggle-on or density change, spread across frames. */
  private async placeMarkersChunked(): Promise<void> {
    if (this.meshes.length === 0) return

    const token = ++this.placementToken
    const zero = new THREE.Matrix4().makeScale(0, 0, 0)

    for (let start = 0; start < this.maxSamples; start += PLACEMENT_CHUNK_SIZE) {
      if (token !== this.placementToken || !this.visible) return

      const end = Math.min(start + PLACEMENT_CHUNK_SIZE, this.maxSamples)
      for (let i = start; i < end; i++) {
        const sample = this.samples[i]
        const surfaceY = sample ? this.sampleSurfaceY(sample.dclX, sample.dclZ) : NaN
        const matrix = sample && Number.isFinite(surfaceY)
            ? (() => {
                dclToThreePos(sample.dclX, surfaceY, sample.dclZ, this.scratch)
                this.dummy.position.copy(this.scratch)
                this.dummy.rotation.set(0, 0, 0)
                this.dummy.scale.set(1, 1, 1)
                this.dummy.updateMatrix()
                return this.dummy.matrix
              })()
            : zero

        for (const mesh of this.meshes) {
          mesh.setMatrixAt(i, matrix)
        }
      }

      for (const mesh of this.meshes) {
        mesh.instanceMatrix.needsUpdate = true
      }
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    }
  }
}