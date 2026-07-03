import * as THREE from 'three'
import { dclToThreePos } from '../bridge/dclTransform'
import { createGltfLoader, sanitizeWearableRoot } from '../avatar/loadWearable'
import { prepareAvatarMaterials } from '../avatar/materials'
import { normalizeWearableWorldScale } from '../avatar/wearableSanitize'
import { parseParcelKey, parcelWorldOrigin } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { bakeStaticMannequinFromRoot, type BakedAvatarMannequinPart } from './bakeAvatarMannequin'
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
/** Hard cap on live mannequin instances (GPU instance matrices). */
export const EDITOR_AVATAR_SCALE_MAX_TOTAL_INSTANCES = 8_192

/** Height samples per animation frame while toggling on (keeps UI responsive). */
const PLACEMENT_CHUNK_SIZE = 128

export type AvatarScaleSample = { dclX: number; dclZ: number }

export type AvatarScalePlacementPlan = {
  countPerParcel: number
  cellsPerAxis: number
  cellM: number
  parcelStride: number
  instanceCount: number
  capped: boolean
}

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

export function defaultAvatarScaleCountForParcelCount(parcelCount: number): number {
  if (parcelCount <= 16) return 256
  if (parcelCount <= 256) return 64
  if (parcelCount <= 4096) return 16
  if (parcelCount <= 10_000) return 4
  return 1
}

export function formatAvatarScaleCountLabel(
  countPerParcel: number,
  plan?: AvatarScalePlacementPlan
): string {
  const count = clampAvatarScaleCount(countPerParcel)
  const axis = avatarScaleGridAxisForCount(count)
  const grid = `${count} (${axis}×${axis})`
  if (!plan?.capped) return grid
  if (plan.parcelStride > 1) {
    return `${grid} · ${plan.instanceCount.toLocaleString()} total (every ${plan.parcelStride} parcels)`
  }
  return `${grid} · ${plan.instanceCount.toLocaleString()} total (capped)`
}

export function buildAvatarScalePlacementPlan(
  footprint: TerrainSceneFootprint,
  requestedPerParcel: number
): AvatarScalePlacementPlan {
  const parcelCount = Math.max(1, footprint.parcels.length)
  const countPerParcel = clampAvatarScaleCount(requestedPerParcel)
  const cellsPerAxis = avatarScaleGridAxisForCount(countPerParcel)
  const cellM = PARCEL_SIZE / cellsPerAxis
  let parcelStride = 1
  let capped = false

  let instanceCount = parcelCount * countPerParcel
  if (instanceCount > EDITOR_AVATAR_SCALE_MAX_TOTAL_INSTANCES) {
    const activeParcels = Math.max(
      1,
      Math.floor(EDITOR_AVATAR_SCALE_MAX_TOTAL_INSTANCES / countPerParcel)
    )
    parcelStride = Math.max(1, Math.ceil(parcelCount / activeParcels))
    instanceCount = Math.ceil(parcelCount / parcelStride) * countPerParcel
    capped = true
  }

  return {
    countPerParcel,
    cellsPerAxis,
    cellM,
    parcelStride,
    instanceCount,
    capped
  }
}

export function avatarScaleSampleAt(
  footprint: TerrainSceneFootprint,
  plan: AvatarScalePlacementPlan,
  index: number
): AvatarScaleSample | null {
  if (index < 0 || index >= plan.instanceCount) return null

  const perParcel = plan.countPerParcel
  const parcelSlot = Math.floor(index / perParcel)
  const localIndex = index % perParcel
  const parcelIndex = parcelSlot * plan.parcelStride
  const key = footprint.parcels[parcelIndex]
  if (!key) return null

  const base = parseParcelKey(footprint.baseParcel)
  const parcel = parseParcelKey(key)
  const origin = parcelWorldOrigin(parcel, base)
  const row = Math.floor(localIndex / plan.cellsPerAxis)
  const col = localIndex % plan.cellsPerAxis

  return {
    dclX: origin.x + (col + 0.5) * plan.cellM,
    dclZ: origin.z + (row + 0.5) * plan.cellM
  }
}

/** @deprecated Prefer procedural `avatarScaleSampleAt` — avoids huge heap arrays on large scenes. */
export function avatarScaleSamplesForFootprint(
  footprint: TerrainSceneFootprint,
  countPerParcel = defaultAvatarScaleCountForParcelCount(footprint.parcels.length)
): AvatarScaleSample[] {
  const plan = buildAvatarScalePlacementPlan(footprint, countPerParcel)
  const samples: AvatarScaleSample[] = []
  for (let i = 0; i < plan.instanceCount; i++) {
    const sample = avatarScaleSampleAt(footprint, plan, i)
    if (sample) samples.push(sample)
  }
  return samples
}

/**
 * Instanced static BaseMale mannequins (bind pose) on a configurable parcel grid (1–256 per parcel).
 * GLB + GPU buffers are created lazily on first toggle-on; freed again when hidden.
 */
export class EditorAvatarScaleGuides {
  private readonly group = new THREE.Group()
  private readonly dummy = new THREE.Object3D()
  private readonly scratch = new THREE.Vector3()
  private readonly footprint: TerrainSceneFootprint
  private placementPlan: AvatarScalePlacementPlan
  private countPerParcel: number
  private bakedParts: BakedAvatarMannequinPart[] | null = null
  private meshes: THREE.InstancedMesh[] = []
  private visible = false
  private initPromise: Promise<void> | null = null
  private placementToken = 0

  constructor(
    footprint: TerrainSceneFootprint,
    private readonly sampleSurfaceY: (dclX: number, dclZ: number) => number
  ) {
    this.footprint = footprint
    this.countPerParcel = defaultAvatarScaleCountForParcelCount(footprint.parcels.length)
    this.placementPlan = buildAvatarScalePlacementPlan(footprint, this.countPerParcel)
    this.group.name = 'editor-avatar-scale-guides'
    this.group.visible = false
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  getCountPerParcel(): number {
    return this.countPerParcel
  }

  getPlacementPlan(): AvatarScalePlacementPlan {
    return this.placementPlan
  }

  isPlacementCapped(): boolean {
    return this.placementPlan.capped
  }

  getActiveInstanceCount(): number {
    return this.placementPlan.instanceCount
  }

  setCountPerParcel(countPerParcel: number): void {
    const next = clampAvatarScaleCount(countPerParcel)
    const nextPlan = buildAvatarScalePlacementPlan(this.footprint, next)
    if (
      next === this.countPerParcel &&
      nextPlan.instanceCount === this.placementPlan.instanceCount &&
      this.meshes.length > 0
    ) {
      return
    }
    this.countPerParcel = next
    this.placementPlan = nextPlan
    if (!this.visible) return
    void this.rebuildMeshesAndPlace()
  }

  setVisible(visible: boolean): void {
    this.placementToken++
    this.visible = visible
    this.group.visible = visible
    if (visible) {
      void this.rebuildMeshesAndPlace()
      return
    }
    this.tearDownMeshes()
  }

  getVisible(): boolean {
    return this.visible
  }

  dispose(): void {
    this.placementToken++
    this.tearDownMeshes()
    this.bakedParts = null
    this.group.removeFromParent()
    this.initPromise = null
  }

  private async ensureReady(): Promise<void> {
    if (this.meshes.length > 0) return
    if (this.initPromise) {
      await this.initPromise
      return
    }

    this.initPromise = (async () => {
      if (!this.bakedParts) {
        const loader = createGltfLoader({})
        const gltf = await loader.loadAsync(BASE_MALE_GLB)
        const avatarRoot = gltf.scene
        avatarRoot.name = 'editor-avatar-mannequin-source'
        sanitizeWearableRoot(avatarRoot)
        normalizeWearableWorldScale(avatarRoot, 'body_shape')
        prepareAvatarMaterials(avatarRoot)

        const baked = bakeStaticMannequinFromRoot(avatarRoot)
        if (!baked?.length) throw new Error('BaseMale mannequin bake failed')
        this.bakedParts = baked
      }

      this.buildMeshes(this.placementPlan.instanceCount)
    })()

    try {
      await this.initPromise
    } finally {
      this.initPromise = null
    }
  }

  private async rebuildMeshesAndPlace(): Promise<void> {
    if (!this.visible) return
    this.placementToken++
    await this.ensureReady()
    const needed = this.placementPlan.instanceCount
    const have = this.meshes[0]?.count ?? 0
    if (have !== needed) {
      this.tearDownMeshes()
      if (!this.bakedParts) return
      this.buildMeshes(needed)
    }
    if (this.visible) void this.placeMarkersChunked()
  }

  private buildMeshes(instanceCount: number): void {
    const parts = this.bakedParts
    const count = Math.min(
      Math.max(0, Math.floor(instanceCount)),
      EDITOR_AVATAR_SCALE_MAX_TOTAL_INSTANCES
    )
    if (!parts?.length || count <= 0) return

    this.dummy.scale.set(0, 0, 0)
    this.dummy.updateMatrix()
    for (const part of parts) {
      let mesh: THREE.InstancedMesh
      try {
        mesh = new THREE.InstancedMesh(part.geometry, part.material, count)
      } catch (err) {
        console.error('[EditorAvatarScaleGuides] InstancedMesh allocation failed', err)
        this.tearDownMeshes()
        return
      }
      mesh.frustumCulled = count <= 4096
      mesh.renderOrder = 10
      for (let i = 0; i < count; i++) {
        mesh.setMatrixAt(i, this.dummy.matrix)
      }
      mesh.instanceMatrix.needsUpdate = true
      this.group.add(mesh)
      this.meshes.push(mesh)
    }
  }

  private tearDownMeshes(): void {
    for (const mesh of this.meshes) {
      this.group.remove(mesh)
      mesh.dispose()
    }
    this.meshes = []
  }

  private async placeMarkersChunked(): Promise<void> {
    if (this.meshes.length === 0) return

    const token = ++this.placementToken
    const zero = new THREE.Matrix4().makeScale(0, 0, 0)
    const { instanceCount } = this.placementPlan

    for (let start = 0; start < instanceCount; start += PLACEMENT_CHUNK_SIZE) {
      if (token !== this.placementToken || !this.visible) return

      const end = Math.min(start + PLACEMENT_CHUNK_SIZE, instanceCount)
      for (let i = start; i < end; i++) {
        const sample = avatarScaleSampleAt(this.footprint, this.placementPlan, i)
        const surfaceY = sample ? this.sampleSurfaceY(sample.dclX, sample.dclZ) : NaN
        const matrix =
          sample && Number.isFinite(surfaceY)
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