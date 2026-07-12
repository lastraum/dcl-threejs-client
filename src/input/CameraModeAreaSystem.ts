import type { Entity } from '@dcl/ecs'
import type { PBCameraModeArea } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/camera_mode_area.gen'
import * as THREE from 'three'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import {
  resolveEntityWorldMatrix,
  type EntityWorldTransformDeps
} from '../transform/entityWorldTransform'

export type ForcedCameraMode = 'first_person' | 'third_person'

/** PB CameraType values (const enum not importable under isolatedModules). */
const CT_FIRST_PERSON = 0
const CT_THIRD_PERSON = 1

type CameraModeAreaDeps = {
  ecs: MirrorComponents
  view: ProjectionView
  getWorldTransformDeps: () => EntityWorldTransformDeps | null
  getPlayerDclPosition: () => { x: number; y: number; z: number } | null
  /** Apply forced freecam mode while inside a CameraModeArea (null = clear force). */
  setForcedCameraMode: (mode: ForcedCameraMode | null) => void
}

type AreaVolume = {
  entity: Entity
  mode: number
  area: { x: number; y: number; z: number }
}

const _inv = new THREE.Matrix4()
const _local = new THREE.Vector3()
const _player = new THREE.Vector3()
const _worldMatrix = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _areaScale = new THREE.Vector3()

/**
 * Scene CameraModeArea volumes — force player freecam to 1st/3rd person while inside.
 * Uses DCL-space Transform + `area` size (rotation applied; Transform.scale ignored).
 */
export class CameraModeAreaSystem {
  private deps: CameraModeAreaDeps | null = null
  private volumes: AreaVolume[] = []
  private cacheDirty = true
  private activeEntity: Entity | null = null

  bind(deps: CameraModeAreaDeps): void {
    this.deps = deps
    this.invalidateCache()
  }

  dispose(): void {
    this.deps?.setForcedCameraMode(null)
    this.deps = null
    this.volumes.length = 0
    this.activeEntity = null
  }

  invalidateCache(): void {
    this.cacheDirty = true
  }

  sync(): void {
    if (!this.deps) return
    this.rebuildCacheIfNeeded()

    const player = this.deps.getPlayerDclPosition()
    const worldDeps = this.deps.getWorldTransformDeps()
    if (!player || !worldDeps) {
      this.clearForce()
      return
    }

    _player.set(player.x, player.y + 0.9, player.z)

    let best: AreaVolume | null = null
    for (const vol of this.volumes) {
      if (!this.isPlayerInside(vol, worldDeps)) continue
      // Prefer first-person if multiple overlap (stricter).
      if (!best || vol.mode === CT_FIRST_PERSON) best = vol
    }

    if (!best) {
      this.clearForce()
      return
    }

    this.activeEntity = best.entity
    if (best.mode === CT_FIRST_PERSON) {
      this.deps.setForcedCameraMode('first_person')
    } else if (best.mode === CT_THIRD_PERSON) {
      this.deps.setForcedCameraMode('third_person')
    } else {
      // Cinematic — scene owns lens via VirtualCamera; do not force freecam.
      this.deps.setForcedCameraMode(null)
    }
  }

  private clearForce(): void {
    if (this.activeEntity === null && !this.deps) return
    this.activeEntity = null
    this.deps?.setForcedCameraMode(null)
  }

  private rebuildCacheIfNeeded(): void {
    if (!this.cacheDirty || !this.deps) return
    this.cacheDirty = false
    this.volumes.length = 0
    const { ecs, view } = this.deps
    for (const [entity, spec] of view.getEntitiesWith(ecs.CameraModeArea)) {
      if (
        entity === view.RootEntity ||
        entity === view.PlayerEntity ||
        entity === view.CameraEntity
      ) {
        continue
      }
      const area = spec as PBCameraModeArea
      const size = area.area
      if (!size) continue
      const sx = Math.abs(size.x) || 0
      const sy = Math.abs(size.y) || 0
      const sz = Math.abs(size.z) || 0
      if (sx < 1e-4 || sy < 1e-4 || sz < 1e-4) continue
      this.volumes.push({
        entity,
        mode: area.mode ?? CT_THIRD_PERSON,
        area: { x: sx, y: sy, z: sz }
      })
    }
  }

  private isPlayerInside(vol: AreaVolume, worldDeps: EntityWorldTransformDeps): boolean {
    // Base pose without Transform.scale (SDK: scale ignored).
    if (!resolveEntityWorldMatrix(vol.entity, worldDeps, { space: 'dcl', out: _worldMatrix })) {
      return false
    }
    _worldMatrix.decompose(_pos, _quat, _scale)
    _areaScale.set(vol.area.x, vol.area.y, vol.area.z)
    _worldMatrix.compose(_pos, _quat, _areaScale)
    _inv.copy(_worldMatrix).invert()
    _local.copy(_player).applyMatrix4(_inv)
    return Math.abs(_local.x) <= 0.5 && Math.abs(_local.y) <= 0.5 && Math.abs(_local.z) <= 0.5
  }
}
