import * as THREE from 'three'
import { Easing } from '@tweenjs/tween.js'
import type { Entity } from '@dcl/ecs'
import type { PBTween } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/tween.gen'
import { applyDclLocalTransform, dclYawToThreeYaw, threeToDclQuat, type DclTransformValues } from './dclTransform'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'

type Vec2 = { x: number; y: number }
type Vec3 = { x: number; y: number; z: number }
type Quat = { x: number; y: number; z: number; w: number }

type TweenRuntime = {
  signature: string
  completed: boolean
  /** Local progress tracker (0–1 for finite tweens). */
  progress: number
  /** Accumulated UV for textureMoveContinuous. */
  textureUv?: Vec2
  /** Reset progress on the frame after signature change. */
  justReset?: boolean
}

const _v3a = new THREE.Vector3()
const _qA = new THREE.Quaternion()
const _qB = new THREE.Quaternion()
const _qOut = new THREE.Quaternion()
const _euler = new THREE.Euler(0, 0, 0, 'YXZ')
/** Matches `TextureMovementType.TMT_TILING` (const enum — use literal under isolatedModules). */
const TMT_TILING = 1

const EASING: Array<(t: number) => number> = [
  Easing.Linear.None,
  Easing.Quadratic.In,
  Easing.Quadratic.Out,
  Easing.Quadratic.InOut,
  Easing.Sinusoidal.In,
  Easing.Sinusoidal.Out,
  Easing.Sinusoidal.InOut,
  Easing.Exponential.In,
  Easing.Exponential.Out,
  Easing.Exponential.InOut,
  Easing.Elastic.In,
  Easing.Elastic.Out,
  Easing.Elastic.InOut,
  Easing.Bounce.In,
  Easing.Bounce.Out,
  Easing.Bounce.InOut,
  Easing.Cubic.In,
  Easing.Cubic.Out,
  Easing.Cubic.InOut,
  Easing.Quartic.In,
  Easing.Quartic.Out,
  Easing.Quartic.InOut,
  Easing.Quintic.In,
  Easing.Quintic.Out,
  Easing.Quintic.InOut,
  Easing.Circular.In,
  Easing.Circular.Out,
  Easing.Circular.InOut,
  Easing.Back.In,
  Easing.Back.Out,
  Easing.Back.InOut
]

function lerpVec2(a: Vec2, b: Vec2, t: number): Vec2 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t
  }
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
    z: a.z + (b.z - a.z) * t
  }
}

function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  _qA.set(a.x, a.y, a.z, a.w)
  _qB.set(b.x, b.y, b.z, b.w)
  _qOut.copy(_qA).slerp(_qB, t)
  return { x: _qOut.x, y: _qOut.y, z: _qOut.z, w: _qOut.w }
}

function applyEasing(fn: number, t: number): number {
  const easing = EASING[fn] ?? EASING[0]
  return easing(Math.min(1, Math.max(0, t)))
}

function tweenSignature(tween: PBTween): string {
  return JSON.stringify({
    duration: tween.duration,
    easingFunction: tween.easingFunction,
    mode: tween.mode,
    playing: tween.playing
  })
}

function isContinuousMode(mode: PBTween['mode']): boolean {
  const kind = mode?.$case
  return (
    kind === 'moveContinuous' ||
    kind === 'rotateContinuous' ||
    kind === 'textureMoveContinuous'
  )
}

function isTextureMode(mode: PBTween['mode']): boolean {
  const kind = mode?.$case
  return kind === 'textureMove' || kind === 'textureMoveContinuous'
}

function collectMeshTextures(mesh: THREE.Mesh): THREE.Texture[] {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  const out: THREE.Texture[] = []
  for (const mat of materials) {
    if (!mat) continue
    if (mat instanceof THREE.MeshStandardMaterial) {
      if (mat.map) out.push(mat.map)
      if (mat.emissiveMap) out.push(mat.emissiveMap)
      if (mat.alphaMap) out.push(mat.alphaMap)
    } else if (mat instanceof THREE.MeshBasicMaterial) {
      if (mat.map) out.push(mat.map)
      if (mat.alphaMap) out.push(mat.alphaMap)
    }
  }
  return out
}

function ensureRepeatWrapping(tex: THREE.Texture): void {
  if (tex.wrapS !== THREE.RepeatWrapping || tex.wrapT !== THREE.RepeatWrapping) {
    tex.wrapS = THREE.RepeatWrapping
    tex.wrapT = THREE.RepeatWrapping
    tex.needsUpdate = true
  }
}

function applyTextureUv(root: THREE.Object3D, uv: Vec2, movementType?: number): void {
  const tiling = movementType === TMT_TILING
  root.traverse((child) => {
    if (!(child instanceof THREE.Mesh)) return
    for (const tex of collectMeshTextures(child)) {
      ensureRepeatWrapping(tex)
      if (tiling) {
        tex.repeat.set(uv.x, uv.y)
      } else {
        tex.offset.set(uv.x, uv.y)
      }
    }
  })
}

function readTextureUv(root: THREE.Object3D, movementType?: number): Vec2 | null {
  let found: Vec2 | null = null
  root.traverse((child) => {
    if (found || !(child instanceof THREE.Mesh)) return
    for (const tex of collectMeshTextures(child)) {
      if (movementType === TMT_TILING) {
        found = { x: tex.repeat.x, y: tex.repeat.y }
      } else {
        found = { x: tex.offset.x, y: tex.offset.y }
      }
      return
    }
  })
  return found
}

function faceMoveDirection(
  transform: DclTransformValues,
  start: Vec3,
  end: Vec3,
  t: number
): void {
  if (t <= 0) return
  const dx = end.x - start.x
  const dz = end.z - start.z
  if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return
  const yaw = Math.atan2(dx, dz)
  _euler.set(0, dclYawToThreeYaw(yaw), 0)
  _qOut.setFromEuler(_euler)
  const dclQ = threeToDclQuat(_qOut)
  transform.rotation = { x: dclQ.x, y: dclQ.y, z: dclQ.z, w: dclQ.w }
}

/** ECS `Tween` → Transform / material UV interpolation; writes `TweenState` back to mirror. */
export class TweenBridge {
  private readonly runtime = new Map<Entity, TweenRuntime>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {}

  sync(view: ProjectionView): void {
    const { Tween } = this.ecs
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(Tween)) {
      active.add(entity)
      const tween = Tween.get(entity)
      const signature = tweenSignature(tween)
      const prev = this.runtime.get(entity)
      if (!prev || prev.signature !== signature) {
        this.runtime.set(entity, {
          signature,
          completed: false,
          progress: tween.currentTime ?? 0,
          textureUv: undefined,
          justReset: true
        })
      }
    }

    for (const entity of this.runtime.keys()) {
      if (!active.has(entity)) this.runtime.delete(entity)
    }
  }

  update(delta: number, view: ProjectionView): void {
    const nodes = this.getNodes()
    if (!nodes) return

    const { Tween, TweenState, Transform } = this.ecs

    for (const [entity, tween] of view.getEntitiesWith(Tween)) {
      const node = nodes.get(entity)
      if (!node) continue

      const playing = tween.playing !== false
      const runtime = this.runtime.get(entity)
      const continuous = isContinuousMode(tween.mode)
      const textureMode = isTextureMode(tween.mode)
      const durationSec = Math.max(tween.duration / 1000, 0)

      let progress = runtime?.progress ?? tween.currentTime ?? 0
      if (runtime?.justReset) {
        progress = runtime.progress
        runtime.justReset = false
      }
      if (runtime && !runtime.completed && playing) {
        if (!continuous && durationSec > 0) {
          progress = Math.min(1, progress + delta / durationSec)
        }
      }
      if (runtime) runtime.progress = progress

      const eased = applyEasing(tween.easingFunction ?? 0, progress)
      let applied = false

      if (textureMode) {
        applied = this.applyTextureTween(node, tween, runtime, delta, eased, playing)
      } else if (Transform.has(entity)) {
        applied = this.applyTransformTween(entity, tween, Transform.get(entity), node, eased, playing, delta)
      }

      if (!applied) continue

      const completed =
        !continuous && durationSec > 0 && playing && progress >= 1 && !runtime?.completed
      if (runtime && completed) runtime.completed = true

      const state = !playing ? 2 : completed || (!continuous && durationSec > 0 && progress >= 1) ? 1 : 0

      TweenState.createOrReplace(entity, { state, currentTime: progress })
    }
  }

  private applyTextureTween(
    node: THREE.Object3D,
    tween: PBTween,
    runtime: TweenRuntime | undefined,
    delta: number,
    eased: number,
    playing: boolean
  ): boolean {
    switch (tween.mode?.$case) {
      case 'textureMove': {
        const { start, end, movementType } = tween.mode.textureMove
        if (!start || !end) return false
        const uv = lerpVec2(start, end, eased)
        applyTextureUv(node, uv, movementType)
        if (runtime) runtime.textureUv = uv
        return true
      }
      case 'textureMoveContinuous': {
        const { direction, speed, movementType } = tween.mode.textureMoveContinuous
        if (!direction || !playing) return false
        let uv = runtime?.textureUv
        if (!uv) {
          uv = readTextureUv(node, movementType) ?? { x: 0, y: 0 }
        }
        const step = speed * delta
        uv = {
          x: uv.x + direction.x * step,
          y: uv.y + direction.y * step
        }
        applyTextureUv(node, uv, movementType)
        if (runtime) runtime.textureUv = uv
        return true
      }
      default:
        return false
    }
  }

  private applyTransformTween(
    entity: Entity,
    tween: PBTween,
    baseTransform: DclTransformValues,
    node: THREE.Object3D,
    eased: number,
    playing: boolean,
    delta: number
  ): boolean {
    const transform = { ...baseTransform }
    let applied = false

    switch (tween.mode?.$case) {
      case 'move': {
        const { start, end, faceDirection } = tween.mode.move
        if (start && end) {
          transform.position = lerpVec3(start, end, eased)
          if (faceDirection) faceMoveDirection(transform, start, end, eased)
          applied = true
        }
        break
      }
      case 'rotate': {
        const { start, end } = tween.mode.rotate
        if (start && end) {
          transform.rotation = slerpQuat(start, end, eased)
          applied = true
        }
        break
      }
      case 'scale': {
        const { start, end } = tween.mode.scale
        if (start && end) {
          transform.scale = lerpVec3(start, end, eased)
          applied = true
        }
        break
      }
      case 'moveRotateScale': {
        const m = tween.mode.moveRotateScale
        if (m.positionStart && m.positionEnd) {
          transform.position = lerpVec3(m.positionStart, m.positionEnd, eased)
          applied = true
        }
        if (m.rotationStart && m.rotationEnd) {
          transform.rotation = slerpQuat(m.rotationStart, m.rotationEnd, eased)
          applied = true
        }
        if (m.scaleStart && m.scaleEnd) {
          transform.scale = lerpVec3(m.scaleStart, m.scaleEnd, eased)
          applied = true
        }
        break
      }
      case 'moveContinuous': {
        const { direction, speed } = tween.mode.moveContinuous
        if (direction && playing) {
          const step = speed * delta
          transform.position = {
            x: transform.position.x + direction.x * step,
            y: transform.position.y + direction.y * step,
            z: transform.position.z + direction.z * step
          }
          applied = true
        }
        break
      }
      case 'rotateContinuous': {
        const { direction, speed } = tween.mode.rotateContinuous
        if (direction && playing) {
          _qA.set(direction.x, direction.y, direction.z, direction.w).normalize()
          _v3a.set(_qA.x, _qA.y, _qA.z)
          if (_v3a.lengthSq() < 1e-8) _v3a.set(0, 1, 0)
          _v3a.normalize()
          _qB.setFromAxisAngle(_v3a, speed * delta)
          _qA.set(
            transform.rotation.x,
            transform.rotation.y,
            transform.rotation.z,
            transform.rotation.w
          )
          _qOut.copy(_qB).multiply(_qA)
          transform.rotation = { x: _qOut.x, y: _qOut.y, z: _qOut.z, w: _qOut.w }
          applied = true
        }
        break
      }
      default:
        break
    }

    if (!applied) return false

    this.ecs.Transform.createOrReplace(entity, transform)
    applyDclLocalTransform(node, transform)
    return true
  }
}
