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
/** Soft rate limit for force-pull spam with unchanged structure key (COD D1). */
let lastHydratePostAt = 0
const VC_HYDRATE_FORCE_MIN_MS = 50

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

  // Locked / cinematic / select stage — worker world pose is authoritative on main.
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
 * Locked (worldFlattened): structure only (entity/lookAt/parent). Continuous pan/edge
 * moves ride `vc-pose-live` — putting pose in the graph key re-hydrated every frame
 * (DecentraCraft RTS VC spam → FPS death + stalled select UI).
 */
export function vcBindGraphKey(pkg: PlayerFrameBoundVc | null): string {
  if (!pkg) return 'cleared'
  const lookAt = (pkg.virtualCamera as { lookAtEntity?: number } | null)?.lookAtEntity ?? 0
  const parent = pkg.transform.parent ?? 0
  if (pkg.worldFlattened) {
    const anchorIds = pkg.anchors
      .map((a) => a.entity)
      .sort((a, b) => a - b)
      .join(',')
    return [`vc=${pkg.entity}`, `lookAt=${lookAt}`, 'flat=1', `anchors=${anchorIds}`].join('|')
  }
  // Follow / hierarchy: structure only — parent/lookAt/scale.
  // Continuous local pos/rot rides `vc-pose-live` (COD D1). Including full transformKey
  // re-hydrated every bob/zoom frame → FPS death + lens flicker.
  const s = pkg.transform.scale
  return [
    `vc=${pkg.entity}`,
    `parent=${parent}`,
    `lookAt=${lookAt}`,
    'flat=0',
    `scale=${s?.x ?? 1},${s?.y ?? 1},${s?.z ?? 1}`
  ].join('|')
}

export function resetVcBindHydrateBaseline(): void {
  lastGraphKey = ''
  forceNextHydrate = false
  lastHydratePostAt = 0
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
  const now = performance.now()
  if (key === lastGraphKey) {
    // Same structure — only force-pull, and rate-limit force spam.
    if (!forceNextHydrate) return null
    if (now - lastHydratePostAt < VC_HYDRATE_FORCE_MIN_MS) {
      forceNextHydrate = false
      return null
    }
  }
  forceNextHydrate = false
  lastGraphKey = key
  lastHydratePostAt = now
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
