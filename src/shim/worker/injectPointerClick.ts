import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import * as extended from '@dcl/ecs/dist/components'
import { preregisterRendererInjectedComponents } from './preregisterRendererInjectedComponents'
import { PointerEventType } from '../../input/pointerConstants'
import type { InjectPointerClickBody } from '../../player/injectPointerClick'
import {
  ensureWorkerPointerEventTimestampAfter,
  nextWorkerPointerEventTimestamp
} from './workerPointerEventTimestamp'
import {
  forEachWorkerPointerEventsResult,
  resolveWorkerPointerEventsResult,
  resolveWorkerUiTransform
} from './resolveBundledUiComponents'

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

function maxPointerResultTimestamp(engine: IEngine): number {
  let maxTs = 0
  forEachWorkerPointerEventsResult(engine, (PointerEventsResult) => {
    for (const [, commands] of engine.getEntitiesWith(PointerEventsResult)) {
      for (const command of commands) {
        const ts = command.timestamp
        if (typeof ts === 'number' && ts > maxTs) maxTs = ts
      }
    }
  })
  return maxTs
}

/** PET_DOWN only — must run before the first pointer-tick `engine.update(0)`. */
export function injectPointerClickDownOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  preregisterRendererInjectedComponents(engine)
  ensureWorkerPointerEventTimestampAfter(maxPointerResultTimestamp(engine))
  const hit = buildPointerHit(body)
  const down = {
    button: body.button,
    state: PointerEventType.PET_DOWN,
    timestamp: nextWorkerPointerEventTimestamp(),
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }
  // One leaf (main pick). Write every 1063 on this engine — bundled inputSystem
  // may be closed over a nameless first instance, not the client-named getter.
  for (const entity of pointerDownTargets(body)) {
    forEachWorkerPointerEventsResult(engine, (PointerEventsResult) => {
      PointerEventsResult.addValue(entity as Entity, down)
    })
  }
}

/** PET_UP only — targets resolved after any post-DOWN remount. */
export function injectPointerClickUpOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  preregisterRendererInjectedComponents(engine)
  ensureWorkerPointerEventTimestampAfter(maxPointerResultTimestamp(engine))
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
    forEachWorkerPointerEventsResult(engine, (PointerEventsResult) => {
      PointerEventsResult.addValue(entity as Entity, up)
    })
  }
}

/** Write PointerEventsResult directly on the scene worker engine (same-tick getClick). */
export function injectPointerClickOnEngine(engine: IEngine, body: InjectPointerClickBody): void {
  injectPointerClickDownOnEngine(engine, body)
  injectPointerClickUpOnEngine(engine, body)
}

/** PET_HOVER_ENTER / PET_HOVER_LEAVE — react-ecs onMouseEnter/Leave via getInputCommand. */
export function injectPointerHoverOnEngine(
  engine: IEngine,
  body: InjectPointerClickBody,
  state: typeof PointerEventType.PET_HOVER_ENTER | typeof PointerEventType.PET_HOVER_LEAVE
): void {
  preregisterRendererInjectedComponents(engine)
  ensureWorkerPointerEventTimestampAfter(maxPointerResultTimestamp(engine))
  const hit = buildPointerHit(body)
  const row = {
    button: body.button,
    state,
    timestamp: nextWorkerPointerEventTimestamp(),
    tickNumber: body.tickNumber,
    hit,
    analog: undefined
  }
  const targets = body.entities.length ? body.entities : [body.entity]
  for (const entity of targets) {
    forEachWorkerPointerEventsResult(engine, (PointerEventsResult) => {
      PointerEventsResult.addValue(entity as Entity, row)
    })
  }
}

/**
 * True when this inject is a **no-target** pointer edge (Explorer level-state):
 * no PE mesh / no scene UI under the cursor. Host is PlayerEntity; hit.entityId is 0.
 * Scene-agnostic — any bundle may read isPressed / isTriggered / getInputCommand here.
 */
export function isLevelStateInjectBody(
  body: Pick<InjectPointerClickBody, 'levelState' | 'sceneUi' | 'entity' | 'hitEntity'>,
  playerEntity: number
): boolean {
  if (body.sceneUi) return false
  if (body.levelState === true) return true
  // Recover lost flag: no-target posts entity=PlayerEntity + hitEntity=0.
  return (
    body.entity === playerEntity &&
    (body.hitEntity === 0 || body.hitEntity === undefined)
  )
}

/**
 * No-target pointer edge (Explorer level-state) — platform law for every scene:
 *
 *   PET_DOWN / PET_UP on PlayerEntity with hit.entityId = 0
 *   global isPressed / isTriggered / getInputCommand for IA_POINTER
 *   live PrimaryPointerInfo + CameraEntity on the same eng.update
 *
 * Do not invent a PE mesh for empty hits. Scene chooses what to do with the edge
 * (ray from PPI, getClick on a mesh entity, UI, etc.).
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
    // Empty hit — never PlayerEntity id or a mesh entity id.
    hitEntity: 0,
    levelState: true,
    sceneUi: false
  }
  if (phase === 'down') injectPointerClickDownOnEngine(engine, edge)
  else injectPointerClickUpOnEngine(engine, edge)
}

/**
 * Global IA_POINTER press from any entity's PointerEventsResult (matches @dcl/ecs buttonState).
 * World PE mesh writes PER on the mesh; no-target writes on PlayerEntity.
 */
export function isIaPointerPressedOnEngine(engine: IEngine, button: number = 0): boolean {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = resolveWorkerPointerEventsResult(engine)
  let latestTs = -1
  let latestState: number | null = null
  for (const [, commands] of engine.getEntitiesWith(PointerEventsResult)) {
    for (const command of commands) {
      if (command.button !== button) continue
      if (
        command.state !== PointerEventType.PET_DOWN &&
        command.state !== PointerEventType.PET_UP
      ) {
        continue
      }
      if (command.timestamp > latestTs) {
        latestTs = command.timestamp
        latestState = command.state
      }
    }
  }
  return latestState === PointerEventType.PET_DOWN
}

/**
 * After world PE mesh UP, also clear global isPressed via PlayerEntity PET_UP (hit 0).
 * Mesh-only UP updates buttonState; pairing PlayerEntity keeps no-target edges clean
 * for the next press (any scene that latches isPressed across PE then empty click).
 */
export function injectGlobalPointerUpOnPlayer(
  engine: IEngine,
  body: InjectPointerClickBody
): void {
  injectLevelStatePointerEdgeOnEngine(engine, body, 'up')
}

/**
 * Diagnostic: CameraEntity × PrimaryPointerInfo.worldRayDirection ∩ plane y=0.
 * Scenes may use this pattern; platform only reports whether poses/PPI are live.
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
