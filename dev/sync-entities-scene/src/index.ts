/**
 * Minimal syncEntity conformance scene — TweenSequence + TL_RESTART.
 *
 * Build: `npm i && npm run build`
 * Client: two peers on the same world + `?syncdebug`
 *
 * Shared enum id `1` → NetworkEntity{networkId:0, entityId:1} on every client.
 * Sync: Transform + Tween + TweenSequence (TweenState is client-only / not networkable).
 *
 * Dual-box guard: never leave an orphan local mesh if peer CRDT already materialised
 * the shared network entity (or if syncEntity throws before NetworkEntity is attached).
 *
 * No JSX — Creator Hub / sdk-commands entry is always `src/index.ts` (esbuild).
 */
import {
  engine,
  Entity,
  Material,
  MeshCollider,
  MeshRenderer,
  NetworkEntity,
  SyncComponents,
  Transform,
  Tween,
  TweenSequence,
  EasingFunction,
  TweenLoop,
  pointerEventsSystem,
  InputAction
} from '@dcl/sdk/ecs'
import { Color4, Vector3 } from '@dcl/sdk/math'
import { ReactEcs, ReactEcsRenderer, UiEntity, Label } from '@dcl/sdk/react-ecs'
import { syncEntity, isStateSyncronized } from '@dcl/sdk/network'

/** Shared network entity enum — same id on all clients (SDK uses networkId=0). */
const SYNC_BOX_ENUM_ID = 1
const NETWORK_ID_SHARED = 0

const BOX_START = Vector3.create(8, 0.5, 8)
const BOX_END = Vector3.create(8, 3, 8)
const TWEEN_MS = 2000

const SYNC_COMPONENT_IDS = [
  Transform.componentId,
  Tween.componentId,
  TweenSequence.componentId
]

let box: Entity | null = null
let status = 'boot'
let synced = false
/** Entity last registered with pointerEventsSystem (rebind if canonical changes). */
let pointerEntity: Entity | null = null

function ui() {
  return ReactEcs.createElement(
    UiEntity,
    {
      uiTransform: {
        width: '100%',
        height: 72,
        positionType: 'absolute',
        position: { bottom: 24, left: 0 },
        justifyContent: 'center',
        alignItems: 'center'
      }
    },
    ReactEcs.createElement(
      UiEntity,
      {
        uiTransform: {
          width: 720,
          height: 64,
          padding: { left: 16, right: 16 },
          justifyContent: 'center',
          alignItems: 'center'
        },
        uiBackground: { color: Color4.create(0.05, 0.06, 0.1, 0.88) }
      },
      ReactEcs.createElement(Label, {
        value: `SyncEntities · ${status} · entity=${box ?? '-'} · isStateSyncronized=${synced ? 'true' : 'false'} · click = restart tween`,
        fontSize: 14,
        color: Color4.White(),
        textAlign: 'middle-center'
      })
    )
  )
}

/** Yo-yo via sequence + TL_RESTART so peers re-run the same authored path. */
function applyBounceTween(entity: Entity): void {
  Tween.createOrReplace(entity, {
    mode: Tween.Mode.Move({ start: BOX_START, end: BOX_END }),
    duration: TWEEN_MS,
    easingFunction: EasingFunction.EF_EASEINSINE
  })
  TweenSequence.createOrReplace(entity, {
    sequence: [
      {
        mode: Tween.Mode.Move({ start: BOX_END, end: BOX_START }),
        duration: TWEEN_MS,
        easingFunction: EasingFunction.EF_EASEOUTSINE
      }
    ],
    loop: TweenLoop.TL_RESTART
  })
  Transform.createOrReplace(entity, {
    position: { ...BOX_START },
    scale: Vector3.create(1, 1, 1)
  })
}

function ensureVisuals(entity: Entity): void {
  MeshRenderer.setBox(entity)
  MeshCollider.setBox(entity)
  Material.setPbrMaterial(entity, {
    albedoColor: Color4.create(0.2, 0.75, 1, 1)
  })
}

function isSharedNetworkBox(network: { networkId: number; entityId: number }): boolean {
  return network.networkId === NETWORK_ID_SHARED && Number(network.entityId) === SYNC_BOX_ENUM_ID
}

/** Prefer the peer/RES materialised entity over a fresh local addEntity(). */
function findSharedNetworkBox(): Entity | null {
  for (const [entity, network] of engine.getEntitiesWith(NetworkEntity)) {
    if (isSharedNetworkBox(network)) return entity
  }
  return null
}

/**
 * Drop extras that share the same enum identity (should not happen, but
 * protects against race orphans after failed syncEntity).
 */
function dedupeSharedNetworkBoxes(keep: Entity): void {
  for (const [entity, network] of engine.getEntitiesWith(NetworkEntity)) {
    if (entity === keep) continue
    if (isSharedNetworkBox(network)) {
      engine.removeEntity(entity)
    }
  }
}

function bindPointer(entity: Entity): void {
  if (pointerEntity === entity) return
  // SDK pointerEventsSystem replaces handlers per entity; re-register on canonical switch.
  pointerEventsSystem.onPointerDown(
    {
      entity,
      opts: { button: InputAction.IA_POINTER, hoverText: 'Restart tween (sync)' }
    },
    () => {
      if (box == null) return
      applyBounceTween(box)
      status = 'tween restarted (synced)'
    }
  )
  pointerEntity = entity
}

/**
 * Attach SyncComponents without re-calling syncEntity when NetworkEntity already
 * owns this enum (syncEntity would throw "id provided is already in use").
 */
function ensureSyncComponents(entity: Entity): void {
  SyncComponents.createOrReplace(entity, { componentIds: [...SYNC_COMPONENT_IDS] })
}

/**
 * Resolve exactly one shared box:
 * 1) reuse NetworkEntity{0, enumId} if peer CRDT already created it
 * 2) else create local + syncEntity
 * 3) on failure, remove orphan mesh so we never show two boxes
 */
function tryBindSharedBox(): boolean {
  const existing = findSharedNetworkBox()
  if (existing != null) {
    ensureVisuals(existing)
    ensureSyncComponents(existing)
    // Peer may already own transform/tween — only seed if missing.
    if (!Tween.getOrNull(existing)) {
      applyBounceTween(existing)
    }
    box = existing
    dedupeSharedNetworkBoxes(existing)
    bindPointer(existing)
    status = `reused network enum=${SYNC_BOX_ENUM_ID}`
    return true
  }

  const created = engine.addEntity()
  ensureVisuals(created)
  applyBounceTween(created)

  try {
    syncEntity(created, [...SYNC_COMPONENT_IDS], SYNC_BOX_ENUM_ID)
  } catch (err) {
    // Profile not ready, or enum claimed mid-frame by inbound CRDT.
    engine.removeEntity(created)
    const raced = findSharedNetworkBox()
    if (raced != null) {
      ensureVisuals(raced)
      ensureSyncComponents(raced)
      if (!Tween.getOrNull(raced)) applyBounceTween(raced)
      box = raced
      dedupeSharedNetworkBoxes(raced)
      bindPointer(raced)
      status = `bound after race enum=${SYNC_BOX_ENUM_ID}`
      return true
    }
    const msg = err instanceof Error ? err.message : String(err)
    status = `waiting sync (${msg.slice(0, 48)})`
    return false
  }

  box = created
  dedupeSharedNetworkBoxes(created)
  bindPointer(created)
  status = `syncEntity enum=${SYNC_BOX_ENUM_ID}`
  return true
}

export function main() {
  ReactEcsRenderer.setUiRenderer(ui)

  engine.addSystem(() => {
    synced = isStateSyncronized()

    if (box == null) {
      tryBindSharedBox()
      return
    }

    // Keep a single shared identity if inbound CRDT spawned a duplicate mid-session.
    const canonical = findSharedNetworkBox()
    if (canonical != null && canonical !== box) {
      // Prefer the NetworkEntity-backed entity; drop our previous local if different.
      if (box !== canonical) {
        // Only remove if the old ref is not the canonical network identity.
        const oldNet = NetworkEntity.getOrNull(box)
        if (!oldNet || !isSharedNetworkBox(oldNet)) {
          engine.removeEntity(box)
        }
      }
      box = canonical
      ensureVisuals(canonical)
      ensureSyncComponents(canonical)
      bindPointer(canonical)
      status = `switched to canonical enum=${SYNC_BOX_ENUM_ID}`
    }
    if (box != null) dedupeSharedNetworkBoxes(box)
  })
}
