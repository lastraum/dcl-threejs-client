/**
 * Session-scoped tour flag: one prop following the leader's spine bone
 * (local leader or remote peer). Survives World rebuild when re-bound.
 */
import type * as THREE from 'three'
import type { AvatarAttachTargetResolver } from '../avatar/AvatarAttachTargets'
import { FollowFlagProp } from './FollowFlagProp'

export class FollowFlagManager {
  private resolver: AvatarAttachTargetResolver | null = null
  private prop: FollowFlagProp | null = null
  private leaderAddress: string | null = null
  private imageDataUrl: string | null = null
  private disposed = false

  bind(scene: THREE.Scene, resolver: AvatarAttachTargetResolver): void {
    if (this.disposed) return
    this.resolver = resolver
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
    this.resolver = null
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

  /** Call after avatar mixers each frame. */
  update(dt: number): void {
    if (this.disposed || !this.prop || !this.resolver || !this.leaderAddress || !this.imageDataUrl) {
      return
    }
    const local = this.resolver.getLocalWallet()?.toLowerCase() ?? ''
    let model: THREE.Object3D | null = null
    if (local && local === this.leaderAddress) {
      model = this.resolver.getLocalSkeleton()?.model ?? null
    } else {
      model = this.resolver.getRemoteSkeleton(this.leaderAddress)?.model ?? null
    }
    if (!model) {
      this.prop.root.visible = false
      return
    }
    this.prop.root.visible = true
    this.prop.updateFromAvatar(model, dt)
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
    this.resolver = null
    this.leaderAddress = null
    this.imageDataUrl = null
  }

  private syncVisibility(): void {
    if (!this.prop) return
    const show = Boolean(this.leaderAddress && this.imageDataUrl)
    if (!show) this.prop.root.visible = false
  }
}
