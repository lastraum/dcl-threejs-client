/**
 * Session-scoped tour flag: circular badge above the leader nametag.
 * Works for local CCT + remote peers (DCL / VRM / ODK).
 */
import * as THREE from 'three'
import { FollowFlagProp } from './FollowFlagProp'

export type FollowFlagCctProvider = {
  getLocalWallet(): string | null | undefined
  /** Local player capsule feet root (physics). */
  getLocalCctRoot(): THREE.Object3D | null
  /** Local visual body yaw (radians, before AVATAR_YAW_OFFSET). */
  getLocalYaw(): number | null
  /** Remote peer scene root (has position when pose known). */
  getRemoteCctRoot(address: string): THREE.Object3D | null
  /** Remote visual yaw in Three space (already includes mesh offset if any). */
  getRemoteYaw(address: string): number | null
  /** World Y of local nametag anchor (top of head). */
  getLocalNameTagWorldY?(): number | null
  /** World Y of remote nametag anchor. */
  getRemoteNameTagWorldY?(address: string): number | null
  /** Active scene camera for billboarding. */
  getCamera?(): THREE.Camera | null
}

const _feetWorld = new THREE.Vector3()

export class FollowFlagManager {
  private cct: FollowFlagCctProvider | null = null
  private prop: FollowFlagProp | null = null
  private leaderAddress: string | null = null
  private imageDataUrl: string | null = null
  private disposed = false

  bind(scene: THREE.Scene, cct: FollowFlagCctProvider): void {
    if (this.disposed) return
    this.cct = cct
    if (!this.prop) {
      this.prop = new FollowFlagProp()
      if (this.imageDataUrl) this.prop.setImageDataUrl(this.imageDataUrl)
    }
    if (this.prop.root.parent !== scene) {
      this.prop.root.removeFromParent()
      scene.add(this.prop.root)
    }
    this.syncVisibility()
  }

  unbindScene(): void {
    this.prop?.root.removeFromParent()
    this.cct = null
  }

  /** Active tour leader (wallet). Null clears the flag prop. */
  setLeader(address: string | null): void {
    const next = address?.trim().toLowerCase() || null
    if (next === this.leaderAddress) return
    this.leaderAddress = next
    this.syncVisibility()
  }

  setImageDataUrl(dataUrl: string | null): void {
    const next = dataUrl?.trim() || null
    if (next === this.imageDataUrl) return
    this.imageDataUrl = next
    this.prop?.setImageDataUrl(next)
    this.syncVisibility()
  }

  getImageDataUrl(): string | null {
    return this.imageDataUrl
  }

  getLeaderAddress(): string | null {
    return this.leaderAddress
  }

  /** Call after player / remote pose updates each frame. */
  update(dt: number): void {
    if (this.disposed || !this.prop || !this.cct || !this.leaderAddress || !this.imageDataUrl) {
      return
    }
    const local = this.cct.getLocalWallet()?.toLowerCase() ?? ''
    let feet: THREE.Object3D | null = null
    let nametagY: number | null = null

    if (local && local === this.leaderAddress) {
      feet = this.cct.getLocalCctRoot()
      nametagY = this.cct.getLocalNameTagWorldY?.() ?? null
    } else {
      feet = this.cct.getRemoteCctRoot(this.leaderAddress)
      nametagY = this.cct.getRemoteNameTagWorldY?.(this.leaderAddress) ?? null
    }

    if (!feet) {
      this.prop.root.visible = false
      return
    }

    feet.updateWorldMatrix(true, false)
    feet.getWorldPosition(_feetWorld)
    const cam = this.cct.getCamera?.() ?? null
    this.prop.updateAboveNametag(_feetWorld, nametagY, cam, dt)
  }

  clear(): void {
    this.leaderAddress = null
    this.imageDataUrl = null
    this.prop?.setImageDataUrl(null)
    this.syncVisibility()
  }

  dispose(): void {
    this.disposed = true
    this.prop?.dispose()
    this.prop = null
    this.cct = null
    this.leaderAddress = null
    this.imageDataUrl = null
  }

  private syncVisibility(): void {
    if (!this.prop) return
    const show = Boolean(this.leaderAddress && this.imageDataUrl)
    if (!show) this.prop.root.visible = false
  }
}
