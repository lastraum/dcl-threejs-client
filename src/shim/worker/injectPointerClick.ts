import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import * as extended from '@dcl/ecs/dist/components'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { PointerEventType } from '../../input/pointerConstants'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import { nextWorkerPointerEventTimestamp } from './workerPointerEventTimestamp'
import { resolveWorkerUiTransform } from './resolveBundledUiComponents'

function buildPointerHit(body: InjectPointerClickBody) {
  // Prefer explicit ray fields; fall back to PPI world ray + estimate origin from hit.
  const dir = body.hitDirection ?? body.primaryPointer?.worldRayDirection
  const origin =
    body.hitOrigin ??
    (dir
      ? {
          x: body.hitPosition.x - dir.x * body.hitDistance,
          y: body.hitPosition.y - dir.y * body.hitDistance,
          z: body.hitPosition.z - dir.z * body.hitDistance
        }
      : undefined)
  return {
    entityId: body.hitEntity,
    position: { ...body.hitPosition },
    globalOrigin: origin ? { ...origin } : undefined,
    direction: dir ? { ...dir } : undefined,
    normalHit: { ...body.hitNormal },
    length: body.hitDistance,
    meshName: body.meshName ?? ''
  }
}

function pointerDownTargets(body: InjectPointerClickBody): number[] {
  const list = body.downEntities ?? body.entities
  return list.length ? list : [body.entity]
}

function pointerUpTargets(body: InjectPointerClickBody): number[] {
  const list = body.upEntities ?? body.entities
  return list.length ? list : [body.entity]
}

/**
 * Resolve PET_UP inject targets after any post-DOWN remount.
 *
 * Scene DOM UI (`body.sceneUi`): react-ecs `onMouseDown` already ran on PET_DOWN.
 * Remount recycles entity ids — UiTransform.has(id) is true for a *new* node that
 * reused the id (scrim/close). PET_UP on that id re-fires the wrong handler.
 * Clear isPressed via PlayerEntity only (identity of click type, not mount size).
 *
 * World mesh / asset-pack Triggers (`onPointerDown` / getClick): PET_UP must land on the
 * same entity as PET_DOWN. Filtering to UiTransform only sent UP to PlayerEntity and broke
 * wall links / open_link (VoxBoards 142,-146 Instagram/Discord/X, marketplace boards).
 *
 * Non-sceneUi with UiTransform (3D-ish UI): keep only targets that still have UiTransform.
 */
function resolveUpInjectTargets(engine: IEngine, body: InjectPointerClickBody): number[] {
  if (body.sceneUi) {
    return [engine.PlayerEntity as number]
  }
  const requested = pointerUpTargets(body)
  if (!requested.length) return [engine.PlayerEntity as number]

  preregisterRendererInjectedComponents(engine)
  const UiTransform = resolveWorkerUiTransform(engine)
  const PointerEvents = generated.PointerEvents(engine)

  const worldAlive = requested.filter(
    (id) => PointerEvents.has(id as Entity) && !UiTransform.has(id as Entity)
  )
  if (worldAlive.length) return worldAlive

  const uiAlive = requested.filter((id) => UiTransform.has(id as Entity))
  if (uiAlive.length) return uiAlive

  // Prefer original mesh targets when PE was cleared mid-click; avoid PlayerEntity so
  // getClick still matches the entity the scene registered onPointerDown against.
  return requested
}

/** PET_DOWN only — must run before the first pointer-tick `engine.update(0)`. */
export function injectPointerClickDownOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const hit = buildPointerHit(body)
  const down = {
    button: body.button,
    state: PointerEventType.PET_DOWN,
    timestamp: nextWorkerPointerEventTimestamp(),
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }
  // Targets come from main: real PE mesh chain, scene UI leaf, or level-state PlayerEntity
  // (global isPressed when no PE in range). Do not invent extra targets here.
  for (const entity of pointerDownTargets(body)) {
    PointerEventsResult.addValue(entity as Entity, down)
  }
}

/** PET_UP only — targets resolved after any post-DOWN remount. */
export function injectPointerClickUpOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const hit = buildPointerHit(body)
  const up = {
    button: body.button,
    state: PointerEventType.PET_UP,
    timestamp: nextWorkerPointerEventTimestamp(),
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }
  const targets = resolveUpInjectTargets(engine, body)
  for (const entity of targets) {
    PointerEventsResult.addValue(entity as Entity, up)
  }
}

/** Write PointerEventsResult directly on the scene worker engine (same-tick getClick). */
export function injectPointerClickOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  injectPointerClickDownOnEngine(engine, body)
  injectPointerClickUpOnEngine(engine, body)
}

/**
 * DecentraCraft (-16,124) ground move/VFX law (catalyst bin/index.js) — NOT getClick:
 *
 *   isPressed(IA_POINTER)  // press arm + release (global buttonState)
 *   PrimaryPointerInfo.worldRayDirection on RootEntity
 *   CameraEntity.position × ray → plane y=0  (oB / Ud)
 *   onGroundClick → nQ (needs selected units) → td() green cylinder MeshRenderer
 *
 * Level-state inject: PET on PlayerEntity for global isPressed / getInputCommand.
 * hit.entityId must be 0 (empty ground) so HS() isPressOnSelectable is false.
 */
export function injectLevelStatePointerEdgeOnEngine(
  engine: IEngine,
  body: InjectPointerClickBody,
  phase: 'down' | 'up'
): void {
  const player = engine.PlayerEntity as number
  const edge: InjectPointerClickBody = {
    ...body,
    entity: player,
    entities: [player],
    downEntities: [player],
    upEntities: [player],
    // Empty ground — never PlayerEntity (1) or a unit id.
    hitEntity: 0,
    levelState: true,
    sceneUi: false
  }
  if (phase === 'down') injectPointerClickDownOnEngine(engine, edge)
  else injectPointerClickUpOnEngine(engine, edge)
}

/**
 * Scene-style ground hit (DecentraCraft oB/Ud): CameraEntity × PPI.worldRayDirection ∩ y=0.
 */
export function diagnoseLevelStateGroundRay(engine: IEngine): {
  camY: number | null
  rayY: number | null
  ground: { x: number; z: number } | null
  ppi: boolean
  cam: boolean
} {
  preregisterRendererInjectedComponents(engine)
  const PrimaryPointerInfo = generated.PrimaryPointerInfo(engine)
  const Transform = extended.Transform(engine)
  const ppi = PrimaryPointerInfo.getOrNull(engine.RootEntity as Entity) as
    | { worldRayDirection?: { x: number; y: number; z: number } }
    | null
  const camT = Transform.getOrNull(engine.CameraEntity as Entity) as
    | { position?: { x: number; y: number; z: number } }
    | null
  const ray = ppi?.worldRayDirection ?? null
  const camPos = camT?.position ?? null
  if (!ray || !camPos || ray.y >= -1e-4) {
    return {
      camY: camPos?.y ?? null,
      rayY: ray?.y ?? null,
      ground: null,
      ppi: !!ray,
      cam: !!camPos
    }
  }
  const t = -camPos.y / ray.y
  if (!(t > 0)) {
    return { camY: camPos.y, rayY: ray.y, ground: null, ppi: true, cam: true }
  }
  return {
    camY: camPos.y,
    rayY: ray.y,
    ground: { x: camPos.x + ray.x * t, z: camPos.z + ray.z * t },
    ppi: true,
    cam: true
  }
}
