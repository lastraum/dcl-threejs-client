import * as THREE from 'three'
import { buildBoneNameSet, normalizeBoneName, resolveBoneName } from './emoteBoneMap'
import type { LocomotionMode } from '../player/locomotion'

/** Explorer footstep puff cadence (seconds between steps). */
export const FOOTSTEP_INTERVAL: Record<LocomotionMode, number> = {
  walk: 0.37,
  jog: 0.31,
  run: 0.25
}

const MIN_MOVE_SPEED = 0.12
const MAX_ACTIVE_PUFFS = 16
const PUFF_LIFETIME = 0.42
const FOOT_PUFF_SCALE = 0.22
const AIR_PUFF_SCALE = 0.38

type ActivePuff = {
  mesh: THREE.Mesh
  life: number
  velocity: THREE.Vector3
}

/** Lightweight pooled dust puffs — foot contacts + air-jump burst. */
export class AvatarLocomotionVfx {
  private scene: THREE.Scene | null = null
  private leftFoot: THREE.Object3D | null = null
  private rightFoot: THREE.Object3D | null = null
  private hips: THREE.Object3D | null = null
  private readonly pool: THREE.Mesh[] = []
  private readonly active: ActivePuff[] = []
  private footstepTimer = 0
  private nextFoot: 'left' | 'right' = 'left'
  private readonly worldPos = new THREE.Vector3()
  private readonly puffGeometry: THREE.CircleGeometry
  private readonly puffMaterial: THREE.MeshBasicMaterial

  constructor() {
    this.puffGeometry = new THREE.CircleGeometry(0.5, 10)
    this.puffMaterial = new THREE.MeshBasicMaterial({
      color: 0xc8b8a0,
      transparent: true,
      opacity: 0.55,
      depthWrite: false,
      side: THREE.DoubleSide
    })
  }

  bind(avatarRoot: THREE.Object3D, scene: THREE.Scene): void {
    this.scene = scene
    this.resolveBones(avatarRoot)
  }

  triggerAirJumpPuff(): void {
    if (!this.hips) return
    this.hips.getWorldPosition(this.worldPos)
    this.worldPos.y -= 0.55
    this.spawnPuff(this.worldPos, AIR_PUFF_SCALE, 1.6)
  }

  triggerFootstep(side: 'left' | 'right'): void {
    const bone = side === 'left' ? this.leftFoot : this.rightFoot
    if (!bone) return
    bone.getWorldPosition(this.worldPos)
    this.worldPos.y -= 0.04
    this.spawnPuff(this.worldPos, FOOT_PUFF_SCALE, 0.85)
  }

  update(
    delta: number,
    state: {
      locomotionMode: LocomotionMode
      horizontalSpeed: number
      grounded: boolean
      nearGround?: boolean
    }
  ): void {
    this.tickPuffs(delta)

    const onGround = state.grounded || state.nearGround === true
    if (!onGround || state.horizontalSpeed < MIN_MOVE_SPEED) {
      this.footstepTimer = 0
      return
    }

    const interval = FOOTSTEP_INTERVAL[state.locomotionMode]
    this.footstepTimer -= delta
    if (this.footstepTimer > 0) return

    this.triggerFootstep(this.nextFoot)
    this.nextFoot = this.nextFoot === 'left' ? 'right' : 'left'
    this.footstepTimer = interval
  }

  dispose(): void {
    for (const puff of this.active) {
      puff.mesh.removeFromParent()
      this.pool.push(puff.mesh)
    }
    this.active.length = 0

    for (const mesh of this.pool) {
      mesh.removeFromParent()
    }
    this.pool.length = 0

    this.puffGeometry.dispose()
    this.puffMaterial.dispose()
    this.scene = null
    this.leftFoot = null
    this.rightFoot = null
    this.hips = null
  }

  private resolveBones(root: THREE.Object3D): void {
    const bones = buildBoneNameSet(root)
    const findBone = (candidates: string[]): THREE.Object3D | null => {
      for (const candidate of candidates) {
        const resolved = resolveBoneName(candidate, bones)
        if (!resolved) continue
        let hit: THREE.Object3D | null = null
        root.traverse((obj) => {
          if (!hit && normalizeBoneName(obj.name) === resolved) hit = obj
        })
        if (hit) return hit
      }
      return null
    }

    this.leftFoot = findBone(['LeftToeBase', 'LeftFoot'])
    this.rightFoot = findBone(['RightToeBase', 'RightFoot'])
    this.hips = findBone(['Hips'])
  }

  private spawnPuff(position: THREE.Vector3, scale: number, upward: number): void {
    if (!this.scene || this.active.length >= MAX_ACTIVE_PUFFS) return

    let mesh = this.pool.pop()
    if (!mesh) {
      mesh = new THREE.Mesh(this.puffGeometry, this.puffMaterial.clone())
      mesh.rotation.x = -Math.PI / 2
      mesh.renderOrder = 2
    }

    mesh.position.copy(position)
    mesh.scale.setScalar(scale)
    const mat = mesh.material as THREE.MeshBasicMaterial
    mat.opacity = 0.55
    mesh.visible = true
    this.scene.add(mesh)

    const spread = 0.35 + Math.random() * 0.25
    const angle = Math.random() * Math.PI * 2
    this.active.push({
      mesh,
      life: PUFF_LIFETIME,
      velocity: new THREE.Vector3(Math.cos(angle) * spread, upward, Math.sin(angle) * spread)
    })
  }

  private tickPuffs(delta: number): void {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const puff = this.active[i]!
      puff.life -= delta
      puff.velocity.y -= 2.5 * delta
      puff.mesh.position.addScaledVector(puff.velocity, delta)

      const t = Math.max(0, puff.life / PUFF_LIFETIME)
      const mat = puff.mesh.material as THREE.MeshBasicMaterial
      mat.opacity = 0.55 * t
      puff.mesh.scale.multiplyScalar(1 + delta * 1.8)

      if (puff.life <= 0) {
        puff.mesh.removeFromParent()
        puff.mesh.visible = false
        this.pool.push(puff.mesh)
        this.active.splice(i, 1)
      }
    }
  }
}
