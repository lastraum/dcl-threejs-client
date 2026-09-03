/**
 * Pool of cyan teleport seals for the play World.
 * Local /goto uses one instance with camera rumble; each peer leave can overlap.
 */
import * as THREE from 'three'
import { CameraShake } from '@vfx/effects/CameraShake.js'
import {
  TeleportRuneSeal,
  type TeleportRuneSealOpts
} from './TeleportRuneSeal'

const MAX_IDLE = 2
const AVATAR_SEAL_RADIUS = 2.8

export type TeleportRunePlayOpts = TeleportRuneSealOpts & {
  /** Camera rumble during the 100m column — local /goto only. */
  rumble?: boolean
}

type LivePlay = {
  seal: TeleportRuneSeal
  rumble: boolean
}

export class TeleportRuneHost {
  private readonly scene: THREE.Scene
  private readonly idle: TeleportRuneSeal[] = []
  private readonly live: LivePlay[] = []
  private readonly shakeRig = { shakeOffset: new THREE.Vector3(), shakeRoll: 0 }
  private readonly shake = new CameraShake(this.shakeRig)
  private rumbleLive = false
  private disposed = false

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  async prewarm(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    scene: THREE.Scene
  ): Promise<void> {
    if (this.disposed) return
    const seal = this.acquire()
    try {
      await seal.prewarm(renderer, camera, scene)
    } finally {
      this.release(seal)
    }
  }

  play(opts: TeleportRunePlayOpts): Promise<void> {
    if (this.disposed) return Promise.resolve()
    const seal = this.acquire()
    const rumble = !!opts.rumble
    const entry: LivePlay = { seal, rumble }
    this.live.push(entry)
    const playOpts: TeleportRuneSealOpts = {
      x: opts.x,
      y: opts.y,
      z: opts.z,
      yaw: opts.yaw,
      radius: opts.radius > 0 ? opts.radius : AVATAR_SEAL_RADIUS,
      onBurst: opts.onBurst,
      onDischarge: () => {
        if (rumble) this.shake.add(0.92, 1 / 0.65, 20)
        opts.onDischarge?.()
      }
    }
    return seal.play(playOpts).finally(() => {
      const i = this.live.indexOf(entry)
      if (i >= 0) this.live.splice(i, 1)
      this.release(seal)
    })
  }

  update(dt: number, time: number, resolution: THREE.Vector2, camera: THREE.Camera): void {
    if (this.disposed) return
    this.rumbleLive = false
    for (const entry of this.live) {
      entry.seal.update(dt, time, resolution, camera)
      if (entry.rumble && entry.seal.isBeamLive()) this.rumbleLive = true
    }
    if (this.rumbleLive) this.shake.rumble(0.085, dt)
    this.shake.update(dt)
  }

  /** Call after the play camera has been written this frame. */
  applyCameraShake(camera: THREE.Camera): void {
    if (this.shakeRig.shakeOffset.lengthSq() <= 0 && this.shakeRig.shakeRoll === 0) return
    camera.position.add(this.shakeRig.shakeOffset)
    camera.rotateZ(this.shakeRig.shakeRoll)
  }

  isLocalBeamLive(): boolean {
    return this.rumbleLive
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.live) entry.seal.dispose()
    this.live.length = 0
    for (const seal of this.idle) seal.dispose()
    this.idle.length = 0
    this.shake.reset()
  }

  private acquire(): TeleportRuneSeal {
    return this.idle.pop() ?? new TeleportRuneSeal(this.scene)
  }

  private release(seal: TeleportRuneSeal): void {
    if (this.disposed) {
      seal.dispose()
      return
    }
    if (this.live.some((e) => e.seal === seal)) return
    if (this.idle.length >= MAX_IDLE) {
      seal.dispose()
      return
    }
    this.idle.push(seal)
  }
}
