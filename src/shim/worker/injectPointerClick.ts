import type { Entity, IEngine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
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
 * Level-state / ground click: force a same-frame DOWN+UP pair on PlayerEntity.
 *
 * @dcl/ecs getClick(button, entity) requires:
 *   1. last UP on that entity in the *current* eng.update frame window
 *   2. a prior DOWN on the *same* entity with timestamp ≤ UP
 *
 * Split browser edges alone are not enough: keyboard reassert floods PlayerEntity
 * PointerEventsResult (maxElements=100) and can shift out the earlier DOWN, so
 * findClick only sees UP → getClick null → no DecentraCraft ground VFX / move marker.
 *
 * Re-writing DOWN with the UP edge's hit (ground point + ray) then UP in one
 * eng.update restores Explorer getClick without zero-hit reassert on play frames.
 */
export function injectLevelStateClickPairOnEngine(
  engine: IEngine,
  body: InjectPointerClickBody
): void {
  const player = engine.PlayerEntity as number
  const paired: InjectPointerClickBody = {
    ...body,
    entity: player,
    entities: [player],
    downEntities: [player],
    upEntities: [player],
    hitEntity: body.hitEntity || player,
    levelState: true,
    sceneUi: false
  }
  injectPointerClickDownOnEngine(engine, paired)
  injectPointerClickUpOnEngine(engine, paired)
}

/**
 * Diagnose whether PlayerEntity has a getClick-capable IA_POINTER pair after inject.
 * Mirrors @dcl/ecs findClick (last UP + prior DOWN, same button).
 */
export function diagnosePlayerGetClickPair(
  engine: IEngine,
  button: number
): {
  hasPair: boolean
  downTs: number | null
  upTs: number | null
  hit: { x: number; y: number; z: number } | null
  perCount: number
} {
  preregisterRendererInjectedComponents(engine)
  const PointerEventsResult = generated.PointerEventsResult(engine)
  const player = engine.PlayerEntity as Entity
  const cmds = Array.from(PointerEventsResult.get(player) as Iterable<{
    button: number
    state: number
    timestamp: number
    hit?: { position?: { x: number; y: number; z: number } }
  }>)
  const forButton = cmds
    .filter((c) => c.button === button)
    .sort((a, b) => b.timestamp - a.timestamp)
  let up: (typeof forButton)[0] | null = null
  let down: (typeof forButton)[0] | null = null
  for (const it of forButton) {
    if (!up) {
      if (it.state === PointerEventType.PET_UP) {
        up = it
        continue
      }
    } else if (!down) {
      if (it.state === PointerEventType.PET_DOWN) {
        down = it
        break
      }
    }
  }
  const hasPair = !!(up && down && down.timestamp <= up.timestamp)
  const pos = up?.hit?.position ?? down?.hit?.position
  return {
    hasPair,
    downTs: down?.timestamp ?? null,
    upTs: up?.timestamp ?? null,
    hit: pos ? { x: pos.x, y: pos.y, z: pos.z } : null,
    perCount: cmds.length
  }
}
