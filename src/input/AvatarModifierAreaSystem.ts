import type { Entity } from '@dcl/ecs'
import type { PBAvatarModifierArea } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/avatar_modifier_area.gen'
import * as THREE from 'three'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import {
  resolveEntityWorldMatrix,
  type EntityWorldTransformDeps
} from '../transform/entityWorldTransform'

/** PB AvatarModifierType values (const enum not importable under isolatedModules). */
const AMT_HIDE_AVATARS = 0
const AMT_DISABLE_PASSPORTS = 1

export type AvatarSample = {
  /** Lowercase wallet / identity key — empty string for local player. */
  id: string
  position: { x: number; y: number; z: number }
}

export type AvatarModifierEffects = {
  hide: boolean
  disablePassports: boolean
}

type AvatarModifierAreaDeps = {
  ecs: MirrorComponents
  view: ProjectionView
  getWorldTransformDeps: () => EntityWorldTransformDeps | null
}

type AreaVolume = {
  entity: Entity
  area: { x: number; y: number; z: number }
  excludeIds: Set<string>
  hide: boolean
  disablePassports: boolean
}

const _inv = new THREE.Matrix4()
const _local = new THREE.Vector3()
const _sample = new THREE.Vector3()
const _worldMatrix = new THREE.Matrix4()
const _pos = new THREE.Vector3()
const _quat = new THREE.Quaternion()
const _scale = new THREE.Vector3()
const _areaScale = new THREE.Vector3()

/**
 * Scene AvatarModifierArea volumes — hide avatars / disable passport UI for avatars
 * whose feet are inside a volume (DCL-space Transform + `area` size).
 *
 * SDK: Transform rotation applied; Transform.scale ignored. Does not affect how a
 * player inside sees avatars outside the region.
 */
export class AvatarModifierAreaSystem {
  private deps: AvatarModifierAreaDeps | null = null
  private volumes: AreaVolume[] = []
  private cacheDirty = true
  /** id → effects after last sync() */
  private effects = new Map<string, AvatarModifierEffects>()
  private passportBlocked = new Set<string>()

  bind(deps: AvatarModifierAreaDeps): void {
    this.deps = deps
    this.invalidateCache()
  }

  dispose(): void {
    this.deps = null
    this.volumes.length = 0
    this.effects.clear()
    this.passportBlocked.clear()
  }

  invalidateCache(): void {
    this.cacheDirty = true
  }

  /**
   * Recompute effects for each sampled avatar (local + remotes).
   * Call after player/remote positions update each frame.
   */
  sync(samples: AvatarSample[]): void {
    if (!this.deps) return
    this.rebuildCacheIfNeeded()
    this.effects.clear()
    this.passportBlocked.clear()

    const worldDeps = this.deps.getWorldTransformDeps()
    if (!worldDeps || this.volumes.length === 0) {
      for (const s of samples) {
        this.effects.set(s.id, { hide: false, disablePassports: false })
      }
      return
    }

    for (const sample of samples) {
      const idKey = sample.id.trim().toLowerCase()
      let hide = false
      let disablePassports = false
      _sample.set(sample.position.x, sample.position.y + 0.9, sample.position.z)
      for (const vol of this.volumes) {
        if (idKey && vol.excludeIds.has(idKey)) continue
        if (!this.isPointInside(vol, worldDeps, _sample)) continue
        if (vol.hide) hide = true
        if (vol.disablePassports) disablePassports = true
      }
      this.effects.set(idKey, { hide, disablePassports })
      if (disablePassports && idKey) this.passportBlocked.add(idKey)
    }
  }

  getEffects(id: string): AvatarModifierEffects {
    return this.effects.get(id.trim().toLowerCase()) ?? { hide: false, disablePassports: false }
  }

  isHidden(id: string): boolean {
    return this.getEffects(id).hide
  }

  isPassportDisabled(id: string): boolean {
    return this.passportBlocked.has(id.trim().toLowerCase())
  }

  private rebuildCacheIfNeeded(): void {
    if (!this.cacheDirty || !this.deps) return
    this.cacheDirty = false
    this.volumes.length = 0
    const { ecs, view } = this.deps
    for (const [entity, spec] of view.getEntitiesWith(ecs.AvatarModifierArea)) {
      if (
        entity === view.RootEntity ||
        entity === view.PlayerEntity ||
        entity === view.CameraEntity
      ) {
        continue
      }
      const areaSpec = spec as PBAvatarModifierArea
      const size = areaSpec.area
      if (!size) continue
      const sx = Math.abs(size.x) || 0
      const sy = Math.abs(size.y) || 0
      const sz = Math.abs(size.z) || 0
      if (sx < 1e-4 || sy < 1e-4 || sz < 1e-4) continue
      const mods = areaSpec.modifiers ?? []
      const hide = mods.includes(AMT_HIDE_AVATARS)
      const disablePassports = mods.includes(AMT_DISABLE_PASSPORTS)
      if (!hide && !disablePassports) continue
      const excludeIds = new Set(
        (areaSpec.excludeIds ?? []).map((id) => String(id).trim().toLowerCase()).filter(Boolean)
      )
      this.volumes.push({
        entity,
        area: { x: sx, y: sy, z: sz },
        excludeIds,
        hide,
        disablePassports
      })
    }
  }

  private isPointInside(
    vol: AreaVolume,
    worldDeps: EntityWorldTransformDeps,
    point: THREE.Vector3
  ): boolean {
    if (!resolveEntityWorldMatrix(vol.entity, worldDeps, { space: 'dcl', out: _worldMatrix })) {
      return false
    }
    _worldMatrix.decompose(_pos, _quat, _scale)
    _areaScale.set(vol.area.x, vol.area.y, vol.area.z)
    _worldMatrix.compose(_pos, _quat, _areaScale)
    _inv.copy(_worldMatrix).invert()
    _local.copy(point).applyMatrix4(_inv)
    return Math.abs(_local.x) <= 0.5 && Math.abs(_local.y) <= 0.5 && Math.abs(_local.z) <= 0.5
  }
}
