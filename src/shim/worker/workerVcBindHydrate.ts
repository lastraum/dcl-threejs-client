import type { Entity, IEngine } from '@dcl/ecs'
import * as extended from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { getWorldPosition, getWorldRotation } from '@dcl/sdk/ecs'
import type { PlayerFrameBoundVc, PlayerFrameBoundVcTransform } from '../types'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'

/**
 * Cold-path VC bind hydrate — scene-agnostic.
 *
 * Locked / cinematic VirtualCameras often sit under deep stage hierarchies. Rebuilding that
 * hierarchy on main is fragile (missing ancestors → wrong world pose). Worker
 * getWorldPosition/Rotation is authoritative — for non-follow shots we ship **world under Root**.
 *
 * Classic PE-follow (parent === lookAt cameraParent) keeps local hierarchy + anchors.
 */

let lastGraphKey = ''
let forceNextHydrate = false

function cloneTransform(tr: {
  position: { x: number; y: number; z: number }
  rotation: { x: number; y: number; z: number; w: number }
  scale?: { x: number; y: number; z: number }
  parent?: number
}): PlayerFrameBoundVcTransform {
  return {
    position: { x: tr.position.x, y: tr.position.y, z: tr.position.z },
    rotation: { x: tr.rotation.x, y: tr.rotation.y, z: tr.rotation.z, w: tr.rotation.w },
    scale: {
      x: tr.scale?.x ?? 1,
      y: tr.scale?.y ?? 1,
      z: tr.scale?.z ?? 1
    },
    parent: tr.parent as number | undefined
  }
}

function worldTransformUnderRoot(
  engine: IEngine,
  entity: Entity,
  root: number
): PlayerFrameBoundVcTransform {
  const p = getWorldPosition(engine, entity)
  const r = getWorldRotation(engine, entity)
  return {
    position: { x: p.x, y: p.y, z: p.z },
    rotation: { x: r.x, y: r.y, z: r.z, w: r.w },
    scale: { x: 1, y: 1, z: 1 },
    parent: root
  }
}

function transformKey(tr: PlayerFrameBoundVcTransform): string {
  return [
    tr.position.x.toFixed(3),
    tr.position.y.toFixed(3),
    tr.position.z.toFixed(3),
    tr.rotation.x.toFixed(4),
    tr.rotation.y.toFixed(4),
    tr.rotation.z.toFixed(4),
    tr.rotation.w.toFixed(4),
    tr.parent ?? 0
  ].join(',')
}

function isReserved(engine: IEngine, id: number): boolean {
  return (
    id === 0 ||
    id === (engine.RootEntity as number) ||
    id === (engine.PlayerEntity as number) ||
    id === (engine.CameraEntity as number)
  )
}

/** parent === lookAt === non-reserved → classic CameraFollow third-person rig. */
function isPeFollowRig(
  engine: IEngine,
  parent: number | undefined,
  lookAt: number | undefined | null
): boolean {
  if (parent === undefined || parent === null || lookAt === undefined || lookAt === null) return false
  if (parent !== lookAt) return false
  if (isReserved(engine, parent)) return false
  return true
}

/**
 * Snapshot bound VC for main.
 * Follow rig → local hierarchy. Locked shot → worker world pose under Root.
 */
export function collectVcBindHydratePackage(engine: IEngine): PlayerFrameBoundVc | null {
  preregisterRendererInjectedComponents(engine)
  const MainCamera = generated.MainCamera(engine)
  const VirtualCamera = generated.VirtualCamera(engine)
  const Transform = extended.Transform(engine)
  const GltfContainer = generated.GltfContainer(engine)
  const MeshRenderer = extended.MeshRenderer(engine)
  const root = engine.RootEntity as number

  const main = MainCamera.getOrNull(engine.CameraEntity as Entity) as
    | { virtualCameraEntity?: number }
    | null
  const vcId = main?.virtualCameraEntity
  if (vcId === undefined || vcId === null) return null
  const vcEntity = vcId as Entity
  if (!VirtualCamera.has(vcEntity) || !Transform.has(vcEntity)) return null

  const tr = Transform.get(vcEntity)
  const spec = VirtualCamera.get(vcEntity) as {
    lookAtEntity?: number
    defaultTransition?: unknown
  }
  const parent = tr.parent as number | undefined
  const lookAt = spec?.lookAtEntity
  const follow = isPeFollowRig(engine, parent, lookAt)

  const virtualCamera: Record<string, unknown> = {}
  if (lookAt !== undefined && lookAt !== null) virtualCamera.lookAtEntity = lookAt
  if (spec?.defaultTransition !== undefined) {
    try {
      virtualCamera.defaultTransition = JSON.parse(JSON.stringify(spec.defaultTransition))
    } catch {
      /* skip */
    }
  }

  if (follow) {
    // Structure only — main PE-follow evaluates f(PE)+local every frame.
    // Do NOT ship moving cameraParent pose here (that re-fired hydrate every tick → FPS death + flicker).
    return {
      entity: vcId,
      virtualCamera,
      transform: cloneTransform(tr),
      anchors: [],
      worldFlattened: false
    }
  }

  // Stage-parented cinematic VC (Genesis Plaza eventCam under the events board):
  // keep local hierarchy so main resolves world pose as the board Tween moves the parent.
  // World-flattening froze the lens at bind-time inactive pose while the board tweened
  // to active — card slid past the camera.
  const parentId = parent as number | undefined
  if (
    parentId !== undefined &&
    parentId !== null &&
    !isReserved(engine, parentId) &&
    Transform.has(parentId as Entity)
  ) {
    const anchors: PlayerFrameBoundVc['anchors'] = []
    // Ship pure-transform ancestors so main has parent Transform rows without waiting CRDT.
    let walk: number | undefined = parentId
    const seen = new Set<number>()
    for (let depth = 0; depth < 24 && walk !== undefined; depth++) {
      if (seen.has(walk) || isReserved(engine, walk)) break
      seen.add(walk)
      if (!Transform.has(walk as Entity)) break
      if (GltfContainer.has(walk as Entity) || MeshRenderer.has(walk as Entity)) {
        // Mesh-bearing parent: still need its Transform for hierarchy; local is enough.
      }
      const atr = Transform.get(walk as Entity)
      anchors.push({ entity: walk, transform: cloneTransform(atr) })
      const next = atr.parent as number | undefined
      if (next === undefined || next === null || next === walk || isReserved(engine, next)) break
      walk = next
    }
    if (
      lookAt !== undefined &&
      lookAt !== null &&
      lookAt !== vcId &&
      !isReserved(engine, lookAt) &&
      Transform.has(lookAt as Entity) &&
      !seen.has(lookAt)
    ) {
      anchors.push({
        entity: lookAt,
        transform: cloneTransform(Transform.get(lookAt as Entity))
      })
    }
    return {
      entity: vcId,
      virtualCamera,
      transform: cloneTransform(tr),
      anchors,
      worldFlattened: false
    }
  }

  // Root-level locked / select stage — worker world pose under Root (no moving parent).
  const anchors: PlayerFrameBoundVc['anchors'] = []
  if (
    lookAt !== undefined &&
    lookAt !== null &&
    lookAt !== vcId &&
    !isReserved(engine, lookAt) &&
    Transform.has(lookAt as Entity) &&
    !GltfContainer.has(lookAt as Entity) &&
    !MeshRenderer.has(lookAt as Entity)
  ) {
    // Pure transform lookAt target — world under Root for aim without mesh live-lock.
    anchors.push({
      entity: lookAt,
      transform: worldTransformUnderRoot(engine, lookAt as Entity, root)
    })
  }

  return {
    entity: vcId,
    virtualCamera,
    transform: worldTransformUnderRoot(engine, vcEntity, root),
    anchors,
    worldFlattened: true
  }
}

/**
 * Hydrate only when *structure* changes.
 * Follow: ignore moving anchor poses (CameraFollow) — those ride vc-pose-live / PE-follow.
 * Locked (worldFlattened): include world pose so select cuts re-hydrate when the shot moves.
 */
export function vcBindGraphKey(pkg: PlayerFrameBoundVc | null): string {
  if (!pkg) return 'cleared'
  const lookAt = (pkg.virtualCamera as { lookAtEntity?: number } | null)?.lookAtEntity ?? 0
  const parent = pkg.transform.parent ?? 0
  if (pkg.worldFlattened) {
    return [
      `vc=${pkg.entity}`,
      `lookAt=${lookAt}`,
      'flat=1',
      `tr=${transformKey(pkg.transform)}`,
      ...pkg.anchors.map((a) => `a${a.entity}=${transformKey(a.transform)}`)
    ].join('|')
  }
  // Follow / hierarchy: entity ids + VC local offset only (not cameraParent world pose).
  return [
    `vc=${pkg.entity}`,
    `parent=${parent}`,
    `lookAt=${lookAt}`,
    'flat=0',
    `local=${transformKey(pkg.transform)}`
  ].join('|')
}

export function resetVcBindHydrateBaseline(): void {
  lastGraphKey = ''
  forceNextHydrate = false
}

export function requestVcBindHydrateFromMain(): void {
  forceNextHydrate = true
}

export function takeVcBindHydrateIfNeeded(engine: IEngine): {
  bind: PlayerFrameBoundVc
  graphKey: string
} | null {
  const pkg = collectVcBindHydratePackage(engine)
  const key = vcBindGraphKey(pkg)
  if (!pkg) {
    if (lastGraphKey !== 'cleared') lastGraphKey = 'cleared'
    forceNextHydrate = false
    return null
  }
  if (!forceNextHydrate && key === lastGraphKey) return null
  forceNextHydrate = false
  lastGraphKey = key
  return { bind: pkg, graphKey: key }
}

/** Whether bound VC is a PE-follow rig (for live pose posting strategy). */
export function isBoundVcPeFollowRig(engine: IEngine): boolean {
  preregisterRendererInjectedComponents(engine)
  const MainCamera = generated.MainCamera(engine)
  const VirtualCamera = generated.VirtualCamera(engine)
  const Transform = extended.Transform(engine)
  const main = MainCamera.getOrNull(engine.CameraEntity as Entity) as
    | { virtualCameraEntity?: number }
    | null
  const vc = main?.virtualCameraEntity
  if (vc === undefined || vc === null) return false
  if (!Transform.has(vc as Entity) || !VirtualCamera.has(vc as Entity)) return false
  const tr = Transform.get(vc as Entity)
  const spec = VirtualCamera.get(vc as Entity) as { lookAtEntity?: number }
  return isPeFollowRig(engine, tr.parent as number | undefined, spec?.lookAtEntity)
}

/** World-flattened Transform payload for live pose of a locked VC. */
export function worldFlattenedVcTransform(
  engine: IEngine,
  vcEntity: Entity
): PlayerFrameBoundVcTransform {
  return worldTransformUnderRoot(engine, vcEntity, engine.RootEntity as number)
}
