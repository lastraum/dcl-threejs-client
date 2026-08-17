import type { Entity, IEngine } from '@dcl/ecs'
import * as components from '@dcl/ecs/dist/components'
import type { AvatarAttachWorkerEntry } from '../../bridge/AvatarAttachBridge'
import { writeHostLwwNoDirty } from './injectHostLww'

function poseUnchanged(
  prev:
    | {
        position: { x: number; y: number; z: number }
        rotation: { x: number; y: number; z: number; w: number }
        scale: { x: number; y: number; z: number }
        parent?: unknown
      }
    | undefined,
  next: {
    position: { x: number; y: number; z: number }
    rotation: { x: number; y: number; z: number; w: number }
    scale: { x: number; y: number; z: number }
    parent: unknown
  }
): boolean {
  if (!prev) return false
  const eps = 1e-4
  return (
    Math.abs(prev.position.x - next.position.x) <= eps &&
    Math.abs(prev.position.y - next.position.y) <= eps &&
    Math.abs(prev.position.z - next.position.z) <= eps &&
    Math.abs(prev.rotation.x - next.rotation.x) <= eps &&
    Math.abs(prev.rotation.y - next.rotation.y) <= eps &&
    Math.abs(prev.rotation.z - next.rotation.z) <= eps &&
    Math.abs(prev.rotation.w - next.rotation.w) <= eps &&
    Math.abs(prev.scale.x - next.scale.x) <= eps &&
    Math.abs(prev.scale.y - next.scale.y) <= eps &&
    Math.abs(prev.scale.z - next.scale.z) <= eps &&
    prev.parent === next.parent
  )
}

/** Apply renderer-owned avatar-relative transforms on the worker scene engine (SDK parity). */
export function applyAvatarAttachTransformsOnEngine(
  engine: IEngine,
  entries: AvatarAttachWorkerEntry[]
): void {
  applyHostTransformsOnEngine(engine, entries, engine.PlayerEntity as number)
}

/**
 * Explorer: renderer Tweens write Transform on the scene store the VM reads
 * (`m.get(nb).scale.y` for new-catch bar, reveal-cam Il/B3 parents, bobber Yo).
 * Host TweenBridge owns interpolation — inject the live pose before systems.
 */
export function applyHostTransformsOnEngine(
  engine: IEngine,
  entries: AvatarAttachWorkerEntry[],
  defaultParent?: number
): void {
  if (!entries.length) return
  const Transform = components.Transform(engine)
  for (const entry of entries) {
    const entity = entry.entity as Entity
    const prev = Transform.has(entity) ? Transform.get(entity) : undefined
    const fallbackParent =
      defaultParent !== undefined ? defaultParent : (prev?.parent ?? 0)
    const next = {
      position: entry.position,
      rotation: entry.rotation,
      scale: entry.scale,
      parent:
        entry.parent !== undefined && entry.parent !== null
          ? (entry.parent as Entity)
          : (fallbackParent as Entity)
    }
    if (poseUnchanged(prev, next)) continue
    writeHostLwwNoDirty(Transform, entity as number, next)
  }
}