# ThreejsClient Re-Architecture Plan — Three.js-Backed Entity Store

> **Status:** Proposal / planning. No production code yet.
> **Branch:** `redo/threejs-projection-arch`
> **Scope:** The **renderer**-side (main-thread) pipeline that turns scene CRDT into a Three.js scene graph. The **explorer** runtime — scene sandbox (worker + `@dcl/ecs`), `~system/*` stubs, comms, content resolution, identity — is **frozen and kept**.

---

## 0. Explorer vs Renderer — what we are (and aren't) touching

These two words are used loosely; this plan pins them down so scope is unambiguous.

- **Explorer** = the whole client application. It owns content resolution (realms/Catalyst/hashes), the **scene runtime** (sandboxing + running `bin/index.js` + `~system/*`), comms (LiveKit/RFC4), avatars (profiles/wearables/emotes), player/input/physics, identity (auth/signed-fetch), UI/HUD, and scene scheduling.
- **Renderer** = the one organ that turns scene state into pixels: Three.js scene graph, materials, GLB load, camera, lights, and the code that builds/updates `Object3D`s from entity data.

```
┌────────────────────────── EXPLORER (frozen) ─────────────────────────┐
│  content resolution · scene runtime (shim) · comms · avatars         │
│  player/input · identity · UI · scene scheduler                      │
│                                                                      │
│        ┌──────────────── RENDERER (rebuilt) ───────────────┐         │
│        │  Three.js scene graph · materials · GLB load       │         │
│        │  camera · lights · the Entity Store (this plan)    │         │
│        └─────────────────────────────────────────────────────┘        │
└──────────────────────────────────────────────────────────────────────┘
```

**This plan is a RENDERER redesign.** It changes how CRDT state becomes Three.js objects. It does **not** touch the shim, comms, content resolution, identity, or scene scripts. That scoping is exactly why it's safe to do incrementally behind the existing CRDT seam, without rebuilding the explorer.

### Keep the shim — do NOT strip and rebuild

The **shim** (the scene runtime: `sceneWorker.ts`, `evaluateSceneBundle`, the `~system/*` stubs, RPC handlers) is the hardest-won, highest-value part of the codebase and the thing that's genuinely hard to reproduce — e.g. the recently-found bug that workers have no `requestAnimationFrame`. That knowledge is now baked into the shim. A "strip and rebuild" would reimplement the exact same runtime, reset working subsystems (comms/avatars/physics/content) to zero simultaneously, and put us in the worst debugging position. DCL itself swapped renderers (Unity → Godot/Bevy) **behind a stable scene protocol** and never threw away the runtime. We do the same: **freeze the shim, rebuild the renderer behind the CRDT membrane, migrate incrementally.**

---

## 1. Goals & Non-Goals

### Goals
- **Full DCL Explorer in the browser, at feature parity** with the Foundation explorers (scenes, avatars, comms, pointer events, tweens, video, emotes, multi-scene worlds).
- **Efficiency:** stop doing per-frame full-engine walks and stop running a second full ECS engine on the main thread. Spend main-thread time only on what actually changed.
- **One source of truth on the render side.** The end-state (Option 2, §5A) is a single store where **Three.js objects *are* the components** — no second `@dcl/ecs` engine, no separate projection maps duplicating the scene graph.
- **Avatars are first-class entities** in that store, so scene-owned entities and avatar-owned entities share one transform/animation/render path (§5C).
- **Multi-scene** support: many parcels/scenes alive at once with a scheduler that ticks only what matters.
- **Composite-first boot:** show geometry from the static snapshot before the scene script's delta stream arrives.

### Non-Goals (explicit decisions)
- **We are NOT replacing the CRDT protocol.** CRDT remains the scene↔renderer wire format. See §2.
- **We are NOT introducing a separate pub/sub event system.** Events already travel as CRDT value-set components or RPC. See §8.
- **We are NOT rebuilding or stripping the shim.** The scene sandbox/worker execution model (`sceneWorker.ts`, `evaluateSceneBundle`, `~system/*` stubs, RPC) is frozen. Only the *main-thread renderer consumer* changes. See §0.
- We are not changing the comms wire protocol (RFC4 / LiveKit). Out of scope.

### Two-step target (why there are two "replace the mirror" phases)
The end goal is **Option 2: a unified, Three.js-backed `EntityStore`** (§5A) where mutating an entity *is* mutating its `Object3D` — one representation, no diffing two copies. We reach it in two steps to de-risk:
1. **Typed projection (Phase 1, §5.1):** decode CRDT into typed maps + a diff stream, deleting the second ECS engine. This is a well-bounded, verifiable step that already removes the biggest waste.
2. **Unified store (Phase 2, §5A):** collapse the projection maps and the Three.js scene graph into a single entity store whose components hold (or directly drive) the `Object3D`. The projection's decoder/diff becomes the store's write path; there is no longer an intermediate map layer to keep in sync with the scene graph.

The projection is not throwaway — it becomes the **write path** of the unified store. Phase 1 ships value on its own; Phase 2 is the architectural payoff.

---

## 2. What CRDT Is, and Why It Stays

The scene script runs the real `@dcl/ecs` engine inside a Web Worker (`src/shim/worker/sceneWorker.ts` via `evaluateSceneBundle`). It communicates with the renderer by exchanging **CRDT messages** — a compact binary delta format (`PUT_COMPONENT` / `DELETE_COMPONENT` / entity create/delete with Lamport timestamps) that the SDK already produces and consumes. CRDT is the right wire format because it solves three real problems for free: (a) **sandbox↔renderer isolation** — the worker never touches Three.js, it only emits component deltas; (b) **last-writer-wins convergence** with Lamport clocks so renderer-owned state (player/camera transforms, `PointerEventsResult`) and scene-owned state merge deterministically; and (c) **peer/state-sync compatibility** — the same encoding is used for `crdtGetState` snapshots and for state that scenes sync across the network. Replacing it would mean re-implementing convergence and breaking SDK7 scene compatibility. **CRDT stays as the wire format. What changes is how the main thread *consumes* it.**

---

## 3. Current Architecture Map (from the code)

| File / Symbol | Role today |
|---|---|
| `src/shim/worker/sceneWorker.ts` | Boots the scene `bin/*.js` in a Worker, evaluates it with `~system/*` stubs, runs the **real** `@dcl/ecs` engine. Drives `requestAnimationFrame` tick → `onUpdate`. Owns the renderer RPC: `rpcCrdt` (`crdt-send`), `rpcGetState` (`crdt-get-state`). Resolves the scene's renderer transport heuristically (`resolveRendererTransport`, `watchRendererTransportOnmessage`) and applies inbound pointer CRDT (`deliverRendererInbound`, `rendererPushQueue`). |
| `src/shim/system/createSystemStubs.ts` | Implements `~system/Runtime`, `~system/EngineApi`, `~system/RestrictedActions`, `~system/CommunicationsController`, `~system/CommsApi`, `~system/UserIdentity`, `~system/SignedFetch`. `EngineApi.crdtSendToRenderer/crdtGetState` are wired to the RPC. `sendBatch` drains `engineApiEvents`. |
| `src/shim/types.ts` | Worker message protocol: `SceneWorkerOutbound` (worker→main) and `MainToWorker` (main→worker). Includes `crdt-send` / `crdt-response`, `crdt-get-state` / `...-response`, `crdt-renderer-push` / `...-ack`, `crdt-round-trip-nudge`, plus all RPC pairs (move-player, trigger-emote, comms, signed-fetch). |
| `src/bridge/CrdtMirror.ts` | **A second full `@dcl/ecs` `Engine()`** on the main thread. Two transports (`scene`, `renderer`), `engine.seal()`. `applyIncoming` feeds worker CRDT into `rendererTransport.onmessage`; `flushOutgoing` runs `engine.update(0)` and returns the `pendingToScene` deltas; `getState` dumps every component via `componentsIter().dumpCrdtStateToBuffer`. |
| `src/bridge/mirrorComponents.ts` | Registers ~27 component defs (`Transform`, `GltfContainer`, `Material`, `MeshRenderer`, `PointerEvents`, `PointerEventsResult`, `Tween`, `AvatarShape`, `VideoPlayer`, …) on the mirror engine so incoming CRDT decodes. |
| `src/bridge/ThreeBridge.ts` | ECS → Three.js. `sync(engine)` **walks the entire engine every frame** (`engine.getEntitiesWith(Transform)`), ensures a `THREE.Group` per entity, sorts by transform depth, re-applies transform/visibility/light to **all** entities each frame, then runs a budgeted mesh-attach pass (`GLTF_BUDGET_PER_FRAME`, hydration budgets). GLB instances via `cache.clone()`. |
| `src/rendering/AssetCache.ts` | Session-scoped GLB/texture cache keyed by content hash. IndexedDB byte cache (`glbByteCache`). `clone()` → `cloneGltfInstance` = `SkeletonUtils.clone` (shares geometry+materials, **separate draw call per instance**). Retry/give-up bookkeeping. |
| `src/rendering/sceneHydration.ts` | `waitForSceneAssets` pumps `syncRenderer` in a `requestAnimationFrame` loop until GLB/texture counts settle, driving the loading bar. Uses `ThreeBridge.getHydrationStats`. |
| `src/core/systems/SceneScriptSystem.ts` | Orchestrator. Owns `CrdtMirror`, `ThreeBridge`, and the satellite bridges (Avatar, Emote, Billboard, Animator, Tween, Video, Collision, GltfColliders, Pointer). Handles every worker message. On `crdt-send`: re-seed reserved entities → `mirror.applyIncoming` → `syncPointerInput` → `mirror.flushOutgoing` → reply `crdt-response`. Contains the fragile pointer push machinery (`rendererPushStash`, `markRendererPushInFlight`, `schedulePointerStashNudge`, `nudgeWorkerCrdtRoundTrip`, `takeRendererPushFallback`). |
| `src/input/PointerEventsSystem.ts` | Raycasts the Three.js scene, then **writes `PointerEventsResult.addValue(...)` and `PrimaryPointerInfo` into the mirror engine**. Reads `PointerEvents` from the mirror to know which entities are interactive and their ranges/priorities. |
| `src/core/World.ts` | Top-level. `start()` drives the loop: `onSyncFrame` (player, comms broadcast, motion bridges) and `onAsyncFrame` (`sceneScript.syncRenderer()` = the full ThreeBridge walk, collision, async bridges). |

### Data flow today (one scene)
```
worker @dcl/ecs engine  --CRDT delta-->  crdt-send  -->  CrdtMirror (2nd engine.update)
                                                              |
                                          mirror engine state (decoded components)
                                                              |
   ThreeBridge.sync(engine) walks WHOLE engine every frame ---+--> THREE.Group per entity
   PointerEventsSystem.writeResult --> mirror.PointerEventsResult --> flushOutgoing --> crdt-response --> worker
```

---

## 4. Identified Waste (concrete)

1. **Second full ECS engine on the main thread.** `CrdtMirror` constructs `Engine()` and registers ~27 components (`registerMirrorComponents`). Every `crdt-send` calls `engine.update(0)` (`flushOutgoing`, `getState`) — a full ECS tick (dirty-iteration, system scheduling machinery, CRDT re-serialization) whose only purpose is to *decode* worker CRDT and *re-encode* renderer-owned deltas. We pay the cost of a complete ECS runtime to use it as a glorified decoder.

2. **Per-frame full-engine walk in `ThreeBridge.sync`.** Every async frame, `sync()` iterates `engine.getEntitiesWith(Transform)`, rebuilds the `active` set, `sortEntitiesByTransformDepth(...)` over **all** entities, and re-applies transform/visibility/light to **every** entity — even when nothing changed. For a multi-thousand-entity scene this is O(N) work per frame for a handful of actual changes. Collision (`syncCollision`), pointer-target rebuild (`rebuildPointerEntitySet`), and avatar/billboard bridges repeat the same full scans.

3. **No instanced rendering.** `AssetCache.clone()` → `cloneGltfInstance` (`SkeletonUtils.clone`) shares geometry/materials but yields **one draw call per entity**. Scenes that place the same GLB hundreds of times (trees, tiles, props) get hundreds of draw calls where one `InstancedMesh` would do. The cache is already hash-keyed (a de-facto prototype cache); the instancing layer is simply missing.

4. **Fragile pointer round-trip.** The `crdt-renderer-push` path plus `rendererPushStash` / ack-timeout / `schedulePointerStashNudge` / `nudgeWorkerCrdtRoundTrip` / `takeRendererPushFallback` in `SceneScriptSystem`, mirrored by `rendererPushQueue` / `resolveRendererTransport` / `deliverRendererInbound` in the worker, is a large amount of compensation code working around the fact that pointer results are pushed *into the mirror engine* and must be flushed back out-of-band. It depends on heuristically discovering the scene's `rendererTransport`.

---

## 5. Target Architecture

The end-state is **Option 2: a unified, Three.js-backed `EntityStore`** (§5A). We get there via the **typed projection** (§5.1) and **diff consumer** (§5.2), which are the intermediate, verifiable steps and become the store's write path. Throughout, CRDT stays the wire format and the worker/shim is untouched.

---

## 5A. End-State: the unified Three.js-backed `EntityStore` (Option 2)

**The core idea: stop maintaining two representations of the world.** Today we have (a) the mirror `@dcl/ecs` engine's component state and (b) the Three.js scene graph, and we spend effort keeping them in sync. The typed projection (§5.1) reduces (a) to plain maps but still leaves *two* copies (typed maps + scene graph). Option 2 collapses them into **one**: an entity store where the renderer-relevant components **are** (or directly own) the `THREE.Object3D`.

### Shape
- A single `EntityStore` keyed by `Entity`. Each record holds the entity's `THREE.Group` (its node in the scene graph) plus the typed component data the renderer needs (transform, gltf handle, material, pointer spec, visibility, light, animator state, …).
- **Mutation = scene-graph mutation, at the point of entry.** Applying a CRDT message looks up the entity record and mutates its `Object3D` directly:
  - `PUT Transform e` → set that group's matrix; reparent if `parent` changed.
  - `PUT GltfContainer e` → attach/instance the cached prototype under that group; `DELETE` → dispose.
  - `PUT Material e` → re-apply to that group's mesh(es).
  - entity delete → tear down the group and owned visuals.
- There is **no diff layer to consume and no full walk**, because the write is the visual change. The "diff set" still exists only for *secondary* consumers that can't be mutated inline (collision baking, pointer-target set, hydration accounting) — they subscribe to change notifications from the store.

### Why this is better than the projection alone
- **One source of truth.** No "maps say X, scene graph says Y" desync class of bugs.
- **No per-frame reconciliation.** Cost is proportional to messages received, not entities alive.
- **Natural ownership.** Renderer-owned entities (player/camera/avatars) and scene-owned entities live in the same store with the same API.

### Why it's still safe
- The store's **write path is exactly the projection decoder** from §5.1 — we don't invent a new decoder, we point the existing one at `Object3D` mutations instead of standalone maps.
- We keep `@dcl/ecs` **in the worker** (scenes need real components/queries/systems). The store is a renderer-side container, not an ECS the scene can see.
- Secondary systems migrate to the same `EntityStore` read API used in §6, so the seam (`ProjectionView`) is forward-compatible: it becomes the store's read facade.

### Relationship to the projection
```
CRDT bytes ──► decoder (from §5.1)
                 │
   Phase 1:      ├──► typed maps ──► ThreeBridge.consumeDiff ──► scene graph   (two copies)
                 │
   Phase 2:      └──► EntityStore.apply ──► mutate Object3D in place            (one copy)
```
Phase 1 proves the decoder and the change-tracking. Phase 2 reroutes that same decoder's output from "write maps, then diff into scene graph" to "write the scene graph directly," and deletes the intermediate maps for renderer-driving components.

---

### 5.1 Typed CRDT Projection (Phase 1 — becomes the store's write path)
A `CrdtProjection` that decodes incoming CRDT messages **directly** into typed `Map`s — no `@dcl/ecs` `Engine()`, no `engine.update()`.

- Reuse the SDK's component **serializers only** (the generated `…gen.ts` Schema `deserialize`/`serialize`), not the engine. Decode `PUT_COMPONENT(entity, componentId, data)` into the right map; handle `DELETE_COMPONENT` and entity deletion.
- Typed stores, one per consumed component:
  - `transformByEntity: Map<Entity, Transform>`
  - `gltfByEntity: Map<Entity, GltfContainer>`
  - `materialByEntity`, `meshRendererByEntity`, `pointerByEntity` (`PointerEvents`), `visibilityByEntity`, `lightByEntity`, `textByEntity`, `tweenByEntity`, `billboardByEntity`, `animatorByEntity`, `avatarShapeByEntity`, `videoPlayerByEntity`, … (one per entry in `mirrorComponents.ts`).
- **Diff emission:** as messages are applied, record `{ entity, componentId, kind: 'put' | 'delete' }` into a per-tick **dirty set**. This is the basis for the diff consumer (§5.2).
- **Renderer-owned outbound:** renderer-owned writes (`PointerEventsResult`, `PrimaryPointerInfo`, reserved `Transform` for Player/Camera) are accumulated locally and **encoded directly to CRDT** with a monotonic Lamport counter, then returned as the `crdt-response` payload. This replaces `flushOutgoing` (`engine.update(0)`) with a tiny purpose-built encoder.
- **Snapshot:** `getState()` becomes "serialize the current renderer-owned components" instead of dumping every component of a full engine.

#### Phase 3 outbound encoder — complete work list (the renderer-owned components)
These are exactly the components the renderer currently writes into the mirror engine and lets `flushOutgoing()` (`engine.update(0)`) serialize. The Phase 3 encoder must reproduce every one of them directly. This is also the precise set excluded from the Phase 1 inbound parity check (they have no inbound copy to compare against) — so this list and the parity-exclusion list are the same set, by design.

| Component | Entity(ies) | CRDT op | Written by (today) |
|---|---|---|---|
| `Transform` | `PlayerEntity`, `CameraEntity` | PUT (LWW) | `ReservedEntitiesSync`, `CrdtMirror.configureSpawn` |
| `MainCamera` | `CameraEntity` | PUT (LWW) | `ReservedEntitiesSync` |
| `PlayerIdentityData` | `PlayerEntity` | PUT (LWW) | `ReservedEntitiesSync` |
| `AvatarBase` | `PlayerEntity` | PUT (LWW) | `ReservedEntitiesSync` |
| `AvatarEquippedData` | `PlayerEntity` | PUT (LWW) | `ReservedEntitiesSync` |
| `PrimaryPointerInfo` | `RootEntity` | PUT (LWW) | `PointerEventsSystem` |
| `PointerEventsResult` | clicked/hovered entities | APPEND_VALUE (grow-only) | `PointerEventsSystem` |
| `TweenState` | tweened entities | PUT (LWW) | `TweenBridge` |
| `Transform` | tweened entities (interpolated) | PUT (LWW) | `TweenBridge` |
| `VideoEvent` | video-player entities | APPEND_VALUE (grow-only) | `VideoPlayerBridge` |

Encoder requirements:
- **Lamport timestamps:** maintain a per-`(entity, componentId)` monotonic counter so the worker's LWW resolution accepts each PUT. `flushOutgoing` gets this for free from `engine.update(0)`; the hand-rolled encoder must replicate it. Grow-only `APPEND_VALUE` uses the value-set timestamp function, not LWW — keep its existing semantics.
- **Dirty-only emission:** encode a component only when its renderer-side value actually changed that tick (mirror the engine's `getCrdtUpdates` dirty-iterator behavior) to avoid flooding the worker.
- **Snapshot path:** `getState()` serializes the current value of every component above (initial reserved-entity bootstrap) — the same set, full dump instead of dirty delta.
- **Acceptance gate:** the pointer same-tick path (`PointerEventsResult` → worker `getClick`) is the hard one and is the Phase 3 gate (§10). Land the easy reserved-entity/tween/video components first; prove pointer last on real scenes (incl. asset-pack Triggers) before deleting `crdt-renderer-push*`.

**Compatibility shim:** `PointerEventsSystem`, `CollisionSystem`, the avatar/tween/etc. bridges currently take `engine: IEngine` + `MirrorComponents` and call `.get/.getOrNull/.has/.getEntitiesWith`. Provide a thin read facade (`ProjectionView`) exposing those same methods backed by the typed maps, so bridges migrate with minimal churn (see §6).

### 5.2 Diff Consumer (replaces per-frame `ThreeBridge.sync`)
`ThreeBridge` stops walking the whole engine. Instead it consumes the projection's per-tick diff:

- For each dirtied `(entity, component)`: patch only that entity's `THREE.Group`.
  - `Transform` put → update matrix + reparent if `parent` changed.
  - `GltfContainer` put → (re)attach/instance mesh; delete → dispose.
  - `Material` put → re-apply to that entity's mesh only.
  - `VisibilityComponent`/`LightSource`/`TextShape`/`MeshRenderer` → same per-entity patch.
  - entity delete → tear down the `THREE.Group` and owned visuals.
- Keep the existing **budgeting** (`GLTF_BUDGET_PER_FRAME`, hydration/soft-hydration budgets) but apply it to a **work queue of changed entities** rather than re-scanning everything. Entities whose GLB is still downloading stay on the queue until the asset is cached.
- Keep depth-ordered parenting only for the *changed* subset (sort the dirty set, not the world).

### 5.3 Asset Prototype Cache + Instancing
- Keep `AssetCache`'s hash-keyed parsed-GLB cache as the **prototype store** (it already is one).
- Cloning policy by content:
  - **Static, non-skinned, repeated GLB** (same hash placed many times) → render via `THREE.InstancedMesh` keyed by `(hash, sub-mesh)`; per-entity instance matrix instead of a full clone. Add/remove instances as entities appear/disappear.
  - **Skinned / animated GLB** (avatars, animated props) → keep `SkeletonUtils.clone` (`cloneGltfInstance`) — instancing can't share skeletons.
  - **One-off GLB** → plain clone.
- This is purely a `ThreeBridge` + `AssetCache` concern; the projection and wire format don't know about it.

### 5.4 Composite-First Boot
- Before the scene-script delta stream is flowing, hydrate from a **snapshot**: either `main.composite` (if present in scene content) or the worker's initial `crdtGetState` response, fed straight into the projection. The diff consumer then renders the snapshot's entities immediately.
- The scene script's subsequent CRDT deltas merge on top (Lamport LWW guarantees correctness). This gives "geometry on screen fast," before `onStart` finishes.

### 5.5 Multi-Scene Scheduler
- One worker **per scene** (already one worker per scene today). A `SceneScheduler` owns N `{ worker, store, ... }` tuples (one `EntityStore` segment per scene; see §5C for the shared-store option).
- **Tick policy:** only request `crdt-send` round-trips for **nearby** scenes (by parcel distance to the player). Distant scenes are **composite-preloaded** (snapshot rendered, script paused) and **LRU-evicted** when far/old.
- Pointer/collision/physics only run for the scene(s) the player is in or adjacent to.

---

## 5C. Avatars as First-Class Entities

Avatars are **not** scene CRDT — they come from the explorer's avatar/profile subsystem (`RemoteAvatarManager`, `peerApi`, comms transforms) and the local player. Today they're rendered through a separate path (`AvatarShapeBridge`, `AvatarComposer`, `RemoteAvatarManager`) that maintains its own Three.js objects, parallel to the scene's `ThreeBridge`. That's a second renderer mini-pipeline.

**Decision: avatars become entities in the same `EntityStore`,** so transform updates, animation ticking, frustum culling, disposal, and (eventually) instancing share **one** code path with scene entities.

### Source-of-truth split (important)
The store accepts entities from **two producers**, tagged by ownership:

| Producer | Entities | Source | Write trigger |
|---|---|---|---|
| **Scene** | scene-owned | worker CRDT (`crdt-send`) | `EntityStore.apply(crdt)` |
| **Avatar manager** | local player + remote peers | profiles/wearables + comms transforms (RFC4) | `EntityStore.upsertAvatar(...)` |

- Each store record carries an **`owner` tag** (`'scene' | 'avatar' | 'reserved'`). This keeps CRDT writes from clobbering avatar-driven records and vice-versa, and lets the multi-scene scheduler evict scene entities without touching avatars.
- **Reserved entities** (Player `1`, Camera `2`) already straddle both worlds (scene reads them via `getPlayer()`; renderer owns their transforms). They stay `reserved`-owned: the renderer writes them into the store **and** encodes them outbound to the worker (unchanged behavior, §5.1 outbound path).

### What avatars gain from the store
- **Unified transform/animation:** remote peer transforms (comms) and local player pose update the same `Object3D` matrices as scene entities; the animator/mixer tick is one pass over the store, not two.
- **Instancing-ready:** repeated wearables/props can later use the same `InstancedMesh` policy (§5.3) — though skinned avatar bodies stay on the `SkeletonUtils.clone` path (§10).
- **One disposal path:** peer leaves → remove its store record → same teardown as a deleted scene entity.

### What stays in the avatar subsystem
- Profile fetch, wearable resolution, `AvatarComposer` (building the avatar GLB/skeleton), emote playback selection, LOD policy. The subsystem still **builds** the avatar's visual; it just **registers/updates** it as a store entity instead of owning a separate scene-graph branch.

### Migration note
This lands **after** the unified store exists (Phase 2). Until then, avatars keep their current bridge; the store's `owner` tag and `upsertAvatar` API are designed in from Phase 0 (the `ProjectionView`/store read facade includes avatar entities) so the later switch is mechanical.

---

### Target data flow (Phase 2 end-state)
```
worker engine --CRDT--> crdt-send --> EntityStore.apply (decode + mutate Object3D in place)
                                            |                         ^
   scene entities ───────────────────────► store ◄──── avatar manager (upsertAvatar: peers + player)
                                            |                         |
                                            |                         | renderer-owned CRDT (encoded directly)
                          PointerEventsSystem.writeResult --> store.queueOutbound --> crdt-response --> worker
                                            |
                          change notifications --> collision bake / pointer-target set / hydration accounting
```

---

## 6. Component-by-Component Migration

### `src/bridge/CrdtMirror.ts` → `CrdtProjection`
- **Deleted:** `Engine()`, `addTransport`, `seal()`, `engine.update(0)`, `componentsIter()` dump.
- **Changes:** `applyIncoming` becomes a CRDT message decoder writing typed maps + dirty set. `flushOutgoing` becomes a direct renderer-owned-component encoder. `getState` serializes only renderer-owned components. `configureSpawn`/reserved-entity seeding stays (writes into `transformByEntity` for Root/Player/Camera).
- **Kept behavior:** the `hasEntities` gate for composite bootstrap (count non-reserved entities in `transformByEntity`).

### `src/bridge/mirrorComponents.ts`
- **Changes:** stop binding component defs to an engine. Replace with a registry of `{ componentId, deserialize, serialize }` (pulled from the same `@dcl/ecs` generated component modules) used by the projection decoder/encoder. The **list** of components stays the same; only the binding changes.

### `src/bridge/ThreeBridge.ts`
- **Kept:** `THREE.Group` per entity, primitive/text/light/gltf attach logic, budgets, material deferral, dispose paths, video-player wiring.
- **Changes:** `sync(engine)` → `consumeDiff(diff, view)`; iterate changed entities only. `getEntityNodes()` stays (bridges depend on it). `getHydrationStats` reads from the projection's typed maps instead of `engine.getEntitiesWith`.
- **Added:** instanced-mesh path (§5.3).

### `src/rendering/AssetCache.ts`
- **Kept:** hash-keyed parse cache, IndexedDB bytes, retry/give-up, texture cache, wearable/emote loaders.
- **Added:** an instancing helper (e.g. `getInstancedMesh(hash)` / per-entity instance handles) and a clone-policy classifier (skinned vs static-repeated vs one-off). `clone()` stays for the skinned/one-off cases.

### `src/rendering/sceneHydration.ts`
- **Kept:** the `requestAnimationFrame` settle loop, loading-bar math, stall/timeout logic.
- **Changes:** pump the **diff consumer + outstanding work queue** instead of `syncRenderer`'s full walk; "pending" is derived from the projection's typed maps and the bridge's work queue.

### `src/core/systems/SceneScriptSystem.ts`
- **Kept:** worker lifecycle, all RPC handlers (move-player, trigger-emote, comms, signed-fetch), `engineApiEvents` wiring, satellite-bridge ownership.
- **Changes:** `mirror` → `projection`. `crdt-send` handler: `projection.apply(data)` → `syncPointerInput` → `projection.takeOutbound()` → reply. `bindPointerEvents` passes a `ProjectionView` instead of `engine`/`components`.
- **Deleted (goal):** the pointer-stash compensation machinery (`rendererPushStash`, `markRendererPushInFlight`, `rendererPushFlightTimer`, `schedulePointerStashNudge`, `nudgeWorkerCrdtRoundTrip`, `takeRendererPushFallback`, `forceMergePointerStash`) — see §10 for the timing caveat that gates this deletion.

### `src/input/PointerEventsSystem.ts`
- **Kept:** raycast, hover/highlight, range/priority logic, result-target ancestor walk.
- **Changes:** swap `engine.getEntitiesWith(PointerEvents)` / `ecs.X.getOrNull` for `ProjectionView` equivalents; `writeResult` calls `view.queuePointerResult(entity, result)` (which appends to the projection's outbound buffer) instead of `PointerEventsResult.addValue` on a live engine. Same semantics, no second engine.

### Satellite bridges (Avatar/Emote/Billboard/Animator/Tween/Video, Collision, GltfColliders)
- Migrate from `IEngine` + `MirrorComponents` to `ProjectionView`. These are mechanical swaps (`getEntitiesWith` → `view.entitiesWith`, `.get`/`.getOrNull`/`.has` → view methods). Behavior unchanged.

---

## 7. Worker Protocol (`src/shim/types.ts`) Changes

**Principle: keep CRDT as the wire format; keep RPC for actions. Minimal protocol change.**

- **Unchanged:** `crdt-send`/`crdt-response`, `crdt-get-state`/`crdt-get-state-response`, and all action RPC pairs (`move-player-to`, `trigger-emote`, `open-external-url`, all `comms-*`, `signed-fetch*`, `engine-api-enqueue`). The worker side (`sceneWorker.ts`, `createSystemStubs.ts`) does **not** change.
- **Candidate simplification (only if §10 timing allows):** retire the dedicated pointer-push channel — `crdt-renderer-push`, `crdt-renderer-push-ack`, `crdt-round-trip-nudge` — and fold renderer-owned pointer CRDT back into the normal `crdt-response` payload. This removes `rendererPushQueue`/`resolveRendererTransport`/`deliverRendererInbound` complexity in the worker. **Deferred** until we confirm scenes still observe clicks on the same tick without the direct push (see §10).
- No new message types are required by the projection itself — it consumes the same `crdt-send` bytes.

---

## 8. Decision on Events: No Pub/Sub

**Question raised:** "maybe we don't need pub/sub for events?"

**Conclusion: correct — we do not add a separate pub/sub system.** Because we keep CRDT as the wire format, every "event" already has a transport:

- **Pointer events (clicks, hover, down/up):** travel as the **value-set CRDT component `PointerEventsResult`** (a "grow-only" append component). The renderer appends results; the scene reads them via its own `PointerEventsResult` in the worker engine. This is already an event stream over CRDT.
- **Avatar emote commands:** `AvatarEmoteCommand` (value-set component) over CRDT.
- **Player-triggered actions (move player, trigger emote, open URL, comms):** **RPC** request/response over the worker channel (`~system/RestrictedActions`, `~system/CommunicationsController`).
- **EngineApi subscriptions** (e.g. comms messages → scene) already flow via `sendBatch`/`engineApiEvents` drain — a queue, not a broadcast bus.

Adding a parallel pub/sub layer would duplicate what CRDT value-set components and RPC already provide, introduce a second ordering/convergence model, and create two sources of truth for the same events. **Keep CRDT wire + RPC for actions. No new event bus.**

---

## 9. Phased Rollout

Each phase keeps the app shippable. The shim stays frozen throughout (§0).

**Phase 0 — Seam (no behavior change).**
Introduce the `ProjectionView` read facade (forward-designed as the future `EntityStore` read API, incl. an `owner` tag and avatar-entity awareness, §5C). Make `ThreeBridge`, `PointerEventsSystem`, and satellite bridges depend on it. Back it temporarily by the existing `CrdtMirror` engine (adapter). *Risk: low.* Lets every later phase be a swap behind the seam.

**Phase 1 — Typed projection alongside the engine (shadow mode).** ✅ *Complete — validated on Genesis Plaza: `parity OK` across 2523 component-entities on a 1291-entity / 596-GLTF scene, zero mismatches.*
Implement `CrdtProjection` decoding the same `crdt-send` bytes into typed maps + a change set. Run it **in parallel** with `CrdtMirror`; assert the typed maps match the engine's component state (dev-only diff check). *Risk: medium (decoder correctness); mitigated by parity assertions.* This decoder is the future store's write path.

- **Implementation:** `src/bridge/CrdtProjection.ts` — `CrdtProjection` (decoder + typed `components: Map<componentId, Map<Entity, value>>` + per-apply `changes` set) and `checkProjectionParity()`. Reuses the SDK CRDT wire reader (`@dcl/ecs/dist/serialization/crdt/message#readMessage`) and each component's `schema.deserialize`, so the decode is byte-identical to the engine.
- **Wiring:** `SceneScriptSystem.runProjectionShadow()` decodes the same `crdt-send` payload right after `mirror.applyIncoming`, then samples parity every 30 ticks, logging to the `projection` debug category.
- **Activation:** gated behind the `?projparity` URL flag (zero cost when off — projection is `null`). Enable it, click around the scene, and watch for `parity OK` vs `parity FAIL` lines.
- **Known-excluded from parity (renderer-local writes the projection can't see):** reserved entities (Root/Player/Camera), grow-only sets (`PointerEventsResult`, `VideoEvent`), `PrimaryPointerInfo` (pointer system), `TweenState` (tween bridge), and `Transform` on entities with a `Tween` (interpolated locally each frame).

**Phase 2 — Diff consumer in `ThreeBridge`.** ✅ *Complete — validated on Genesis Plaza (2523 parity matches / 1291 entities) and `pizzaparty.dcl.eth` (15389 parity matches / 5053 entities / 4917 nodes), `diff consumer ACTIVE` with clean parity throughout.*
Add `consumeDiff` driven by the projection's change set; keep the full-walk `sync` as a fallback behind a flag. Validate identical scene graphs. *Risk: medium (missed-diff bugs → stale visuals); mitigated by periodic full-resync safety pass during hydration.*

- **Implementation:** `ThreeBridge.consumeDiff(diff, view)` patches only the entities/components named in the diff: per-entity node create/remove, depth-sorted transform + parent + visibility + light, and a standing **pending-mesh set** (`pendingMeshEntities`) that keeps the existing budgeted attach pass (`runDiffMeshPass`) — entities whose GLB is still downloading stay queued until cached. Component **values** are still read from the parity-verified mirror engine (the diff only says *what* changed); switching value reads to the projection/store happens in Phase 3–4.
- **Diff accumulation:** `SceneScriptSystem.runProjectionShadow()` folds each `crdt-send` batch's `projection.changes` into `pendingDiff` (`entity → componentId → kind`, last-write-wins). The render frame (`syncRenderer`) swaps the map out and hands it to `consumeDiff`.
- **Renderer-local carve-out:** tweened entities (`Tween`) interpolate `Transform` renderer-locally each frame and never appear in the worker diff, so `consumeDiff` re-applies their transform every frame. Billboards/animators already mutate `Object3D`s directly, so they're unaffected.
- **Safety net:** full-walk `sync` still runs during hydration (`canConsumeDiff()` is false while `hydrationMode`), as the post-hydration baseline, and every `FULL_RESYNC_INTERVAL` (120) diff frames — self-healing any missed diff or mid-async-sync race. A full walk clears `pendingDiff` so nothing is double-applied.
- **Activation:** gated behind the `?diffconsumer` URL flag (zero cost when off — projection is `null` unless `?projparity`/`?diffconsumer`). Combine with `?projparity` to keep asserting decode parity while the diff drives rendering.

**Phase 3 — Cut over outbound + delete the second engine.** ✅ *Complete (2026-06-15).*
Main renderer pipeline (inbound decode, diff consumer, outbound via encoder, scene-bridge reads) is now **unconditional** (flags removed, projection + CrdtEncoder + ProjectionView are the defaults). `CrdtMirror`'s `Engine()` is retained only for `getState` bootstrap snapshot and the pointer direct-push timing path (pending final same-tick validation on asset-pack Trigger scenes). The dedicated `crdt-renderer-push` / stash / nudge machinery is still present for same-tick pointer delivery safety; once proven on real scenes the push channel and remaining mirror Engine usage for renderer CRDT can be fully retired (see §10).

All previous sub-steps (3a–3e.3 source-capture, read facade, network parity, coverage audit, etc.) landed in prior sessions. This session defaulted the paths, removed the `?projparity` / `?diffconsumer` / `?encparity` / `?encoderout` / `?storeread` gating, and hardened the encoder as the primary outbound writer.

- **Sub-step 3a (landed):** `src/bridge/CrdtEncoder.ts` — `CrdtEncoder` reproduces the renderer-owned **reserved-entity LWW** outbound (`Transform` on Player/Camera, `MainCamera`, `PlayerIdentityData`, `AvatarBase`, `AvatarEquippedData`) using the SDK wire writer (`PutComponentOperation.write`) + each component's `schema.serialize`, with a per-`(entity,componentId)` monotonic Lamport counter and **dirty-only emission** (skips unchanged values). Runs in **shadow mode** behind `?encparity`: `SceneScriptSystem.runEncoderShadow()` encodes from the same post-`flushOutgoing` engine values and `checkEncoderParity()` asserts every covered PUT the engine flushed is **byte-identical** to the encoder's serialized value (tolerates the encoder's dedup vs the engine's emit-every-`createOrReplace`). Zero runtime behavior change — `crdt-response` still carries `flushOutgoing()` output.
- **Sub-step 3b (done):** proved `encoder parity OK` on real scenes — Genesis Plaza shows `parity OK — 2523` (inbound) alongside `encoder shadow ACTIVE` + `encoder parity OK — 5 renderer-owned PUT(s) match` (outbound, byte-identical).
- **Sub-step 3c — tween (landed):** `CrdtEncoder` now also reproduces the **tween-path LWW** outbound. The renderer rewrites `TweenState` (on every tweened entity) and the interpolated `Transform` (on tween-owned entities) via `TweenBridge`; the encoder scans `getEntitiesWith(TweenState)` each `encode()` and emits both with the same dirty-only + Lamport machinery. Entity set is **dynamic**, so the parity oracle moved from fixed `coveredEntities`/`coveredComponents` sets to a `covers(entity, componentId)` predicate: `TweenState` is renderer-owned on any entity, `Transform` is renderer-owned on reserved (Player/Camera) **and** tweened entities (scene-owned Transforms stay out of scope). Still shadow-mode behind `?encparity`; `crdt-response` unchanged.
- **Sub-step 3c — grow-only (landed):** `CrdtEncoder` now also reproduces the grow-only **APPEND** outbound (`PointerEventsResult`, `VideoEvent`). Each `encode()` diffs every entity's value-set against a per-`(entity,componentId)` multiset of values it already emitted and writes one `AppendValueOperation` (timestamp 0, matching the engine) per newly-appeared value. Because pointer results flush through the dedicated `flushPendingPointerCrdt()` → `crdt-renderer-push` path (not `crdt-send`), the encoder shadow now runs on **both** flush sites; the parity oracle validates APPEND messages as a per-`(entity,componentId)` multiset and the check is forced (not just sampled) on any tick that produced appends, logged distinctly as `encoder parity OK — … incl. N grow-only append(s)`. Still shadow-mode behind `?encparity`; `crdt-response`/`crdt-renderer-push` payloads unchanged.
- **Sub-step 3d — coverage audit + cutover (landed, behind `?encoderout`):** `flushOutgoing()` returns *two* kinds of scene-transport messages — genuine renderer-owned local writes (the encoder's domain) **and echoed inbound** (the SDK CRDT system re-broadcasts applied inbound to every non-origin transport, `systems/crdt/index.js`). The cutover must drop the echo but never a genuine write, so `checkEncoderParity` now also runs a **coverage audit**: any `flushOutgoing` PUT/APPEND/DELETE that is neither encoder-covered nor an echo of this tick's inbound is reported as `uncovered` (logged `encoder COVERAGE GAP …`). Under `?encoderout` the `crdt-send` handler ships the encoder's payload (echo dropped) **only on ticks with zero coverage gap**, falling back to full engine bytes otherwise — so a gap degrades to today's behavior, never data loss. The engine still runs (inbound apply + component reads for rendering) and pointer keeps its dedicated `crdt-renderer-push` path until 3e.
- **Sub-step 3d — cutover hardening (landed, after first real-scene run under `?encoderout`):** validating on a busy game scene (`ChessGameManager`, ~2.4k entities) surfaced three issues the gate either caught or needed to catch:
  1. **`PrimaryPointerInfo` (comp 1209) on RootEntity was uncovered** — it's a documented renderer-owned LWW write (§ table above) the encoder simply hadn't been wired to emit. Added it to the reserved-entity LWW set (read from `engine.RootEntity`), so it now matches like the other reserved PUTs. (This was the persistent `COVERAGE GAP — PUT entity=0 comp=1209`; safely handled by fallback in the meantime.)
  2. **Cutover gate now also requires `mismatches === 0`, not just `uncovered === 0`.** A grow-only `PointerEventsResult` append the snapshot encoder occasionally fails to reproduce (set pruning / two-flush-site timing) is a *mismatch* on a covered component, which the old gate ignored — so cutover would have silently dropped that append. Gating on mismatches too means such a tick deterministically falls back to engine bytes (never a dropped pointer result). Grow-only append byte-stability is intentionally deferred to 3e's dedicated pointer path.
  3. **The parity oracle is now crash-proof.** A malformed/partial chunk made `readMessage` throw `Outside of the bounds of written data` *out of* `checkEncoderParity` and the `crdt-send` handler — under cutover that stalls the round-trip. Both decode loops (`buildInboundIndex` + the `flushOutgoing` scan) are wrapped: an inbound parse error is best-effort swallowed, a `flushOutgoing` parse error is recorded as a mismatch so the tick falls back rather than shipping an unverified payload.
  4. **Sample the audit instead of running it per tick (perf).** First cutover run dropped FPS ~100→~48 (and worse on busier scenes): arming cutover had flipped the coverage/parity audit from sampled (1/30 ticks) to *every* tick, and that audit is O(scene traffic) — it decodes `flushOutgoing` (which under cutover is bloated with *echoed inbound*, since the SDK re-broadcasts applied inbound to the scene transport) plus re-parses the inbound, allocating per-message strings/Sets → CPU + GC churn each frame. Fix: keep the audit sampled (~1/30 ticks) in **both** shadow and cutover, and only ship encoder bytes on a tick we actually audited *and* found clean (`audited` flag on the shadow result); every other tick ships the proven engine `flushOutgoing` bytes. So the heavy audit stays off the per-tick hot path while the cutover is still exercised and verified periodically. (An attempt to instead drop echoes at the mirror's scene transport was reverted — it touched SDK transport internals and correlated with a further FPS drop; sampling is simpler and lower-risk.) Lamport mixing across the engine/encoder payloads is harmless here: both serialize the same renderer-owned values, so a stale-lamport encoder PUT is just ignored and the engine re-ships next tick. Grow-only appends ride the engine-bytes fallback on non-audited ticks, so nothing is dropped.
  *Validate: re-run `?encoderout` on the same scene; expect FPS back near the shadow-mode baseline, `encoder CUTOVER ACTIVE` appearing periodically, no parse crash, and only the occasional throttled `COVERAGE GAP`/`FAIL` line (which just defers that tick to engine bytes). Movement/rendering/non-pointer interactions must stay identical. Note: per-tick, always-on cutover with the engine deleted is a **3e** goal (encoder becomes the sole outbound writer via source-captured writes), which removes the audit entirely rather than sampling it.
- **Sub-step 3e.1 — source-capture grow-only appends (landed):** the snapshot-diff append path (3c) was replaced by **source capture**. The renderer's grow-only writers now feed the encoder at the exact `addValue` site: `PointerEventsSystem.writeResult` and `VideoPlayerBridge.update` call a `recordAppend(componentId, entity, value)` sink (wired through `SceneScriptSystem.recordRendererAppend` → `CrdtEncoder.recordAppend`), which serializes the value *at that instant* and queues one `AppendValueOperation` for the next `encode()`. This is byte-exact and immune to grow-only **set pruning** (older entries the engine still flushes but a post-flush snapshot can no longer see — the cause of the intermittent `missing append in encoder` mismatch in 3d). It also removes the encoder's `getEntitiesWith`/`def.get` scan over grow-only sets, dropping one more engine read dependency. No-op when the encoder is disabled (sink forwards to `this.encoder?` only). *Validate under `?encparity`: click around + play video; expect `encoder parity OK … incl. N grow-only append(s)` with zero `missing append` mismatches.*
- **Sub-step 3e.2 — projection read API + network-entity support (landed, additive):** `CrdtProjection` gained the read surface a projection-backed view will need — `has(componentId, entity)`, `entitiesWith(componentId)`, `componentMap(componentId)`, `isDeleted(entity)` — and now replicates the engine's **network-entity Transform handling**. The mirror engine's CRDT system strips the parent of an incoming Transform when the entity carries both `NetworkEntity` + `NetworkParent` (`fixTransformParent`, `systems/crdt/index.js`), because the wire parent is in the *sender's* id space; the projection didn't, which was the `core::Transform e2599: value differs` parity FAIL on network entities. The projection now registers those two built-in components (ids from `defineNetworkEntity/defineNetworkParent(mirror.engine)`, presence-only) and applies the same parent strip on `Transform` puts for network-parented entities. Still additive — only the projection's internal maps change, validated by the existing `?projparity` oracle (no live read path uses it yet). *Validate under `?projparity` on a networked scene (e.g. Genesis Plaza): the recurring `Transform eNNNN: value differs` lines for network entities should disappear.*
- **Sub-step 3e.2 validation (done):** confirmed on Genesis Plaza — `projection parity OK — 2523 component-entities match` with **zero** `Transform eNNNN: value differs` lines (network parity cleared), and `encoder parity OK — 28 op(s) match incl. 2 grow-only append(s)` on click (source-capture appends exact).
- **Sub-step 3e.3 — projection-backed read facade (landed, behind `?storeread`):** `createStoreComponents` (`ProjectionView.ts`) builds a `MirrorComponents`-shaped facade via `Object.create(realDef)` — reads (`get`/`getOrNull`/`has`) come from `CrdtProjection`, writes (`createOrReplace`/`addValue`) write-through to **both** the projection (so renderer-owned values read back immediately) and the live mirror engine (kept as the outbound flush source + parity oracle + fallback). `projectionViewFromProjection` backs `getEntitiesWith` by iterating the projection's component maps. `CrdtProjection.setRenderer`/`appendRenderer` store renderer writes with a timestamp that outpaces inbound (so interpolated tween Transforms win LWW), without polluting the inbound `changes` diff. Under `?storeread`, `SceneScriptSystem` routes the **scene-render bridges** (ThreeBridge, AvatarShape, Billboard, Animator, Tween, Video, Collision, GltfColliders) through the facade + projection-backed view; **pointer** (needs `IEngine`) and **AvatarEmoteCommand** (grow-only value-set the projection stores only as a latest value) stay on the engine + engine-backed `mirrorView` for a later sub-step. Default off → zero behavior change when the flag is absent (facade/projection not even constructed). *Validate with `?storeread&projparity` (and optionally `&diffconsumer`) on Genesis Plaza: scene renders/tweens/videos/collisions identically, parity stays OK, movement + non-migrated interactions unchanged.*
- **Sub-step 3e (remaining):** pointer same-tick acceptance gate — route `PointerEventsResult` via plain `crdt-response` and prove same-tick click delivery on real scenes (incl. asset-pack Triggers); then delete `crdt-renderer-push*` / `crdt-round-trip-nudge` / `rendererPushStash` and `CrdtMirror`'s `Engine()` once reads come from the projection/store. The remaining engine-read dependencies before deletion: ~12 bridge/system consumers reading via `mirror.components` + `engine.getEntitiesWith`, network-entity id remapping + `fixTransformParent` (projection gap; the e2599 Transform parity FAIL), and the `crdt-get-state` composite-boot snapshot (`dumpCrdtStateToBuffer`). Tracked as todos e2–e10.

**Phase 4 — Unify into the Three.js-backed `EntityStore` (Option 2, §5A).**
Collapse the projection maps + scene graph into one store: the decoder mutates `Object3D`s in place for renderer-driving components; secondary systems (collision/pointer-target/hydration) subscribe to change notifications. Delete the intermediate maps for those components. *Risk: high (this is the central refactor); mitigated by landing it component-by-component behind the `consumeDiff` flag, keeping Phase 2 path as fallback per component.*

**Phase 5 — Avatars as store entities (§5C).**
Register local player + remote peers via `EntityStore.upsertAvatar` with `owner:'avatar'`; route transform/animation through the store's single pass. Retire the parallel avatar scene-graph branch (keep `AvatarComposer`/wearable build). *Risk: medium–high (ownership clobber, comms cadence vs store writes); mitigated by `owner` tag and starting with remote peers before the local player.*

**Phase 6 — Asset prototype cache + instancing.**
Add `InstancedMesh` path for static repeated GLBs (scene props and repeated wearables); keep skinned clone path for avatar bodies. *Risk: medium (instance transform/visibility correctness, frustum culling); mitigated by per-hash opt-in.*

**Phase 7 — Composite-first boot.**
Hydrate from `main.composite`/initial `crdtGetState` into the store before the delta stream. *Risk: low–medium (snapshot vs delta merge); Lamport LWW handles overlap.*

**Phase 8 — Multi-scene scheduler.**
`SceneScheduler` with distance-based tick gating, composite preload, LRU eviction; store segmented by scene with shared avatars. *Risk: high (lifecycle, comms/physics scoping); land last, behind a flag, starting with 2 adjacent scenes.*

**Phase 9 — Protocol cleanup (optional).**
If Phase 3 proves same-tick click delivery via plain `crdt-response`, retire `crdt-renderer-push*` and `crdt-round-trip-nudge` (§7). *Risk: medium; fully reversible.*

---

## 10. Open Questions / Risks

- **`getClick` / same-tick pointer timing — DEFERRED to the Phase 3 acceptance gate.** Today pointer results are flushed via the direct `crdt-renderer-push` path so scenes see clicks the same tick (the entire `rendererPushStash`/ack/nudge machinery exists for this). The projection must still feed `inputSystem.getClick` on the **worker** engine. Open question: can renderer-owned `PointerEventsResult` ride the normal `crdt-response` and still arrive before the scene's input system reads it that tick? **Decision (deferral):** the current pointer machinery is **frozen as-is** — not extended, not further patched — until Phase 3. Pointer same-tick delivery is the **Phase 3 acceptance gate**: getting it right via plain `crdt-response` is what *earns* the deletion of `crdt-renderer-push*` / `crdt-round-trip-nudge` / `rendererPushStash`. Investing more in the compensation code now is throwaway work since Phase 3/9 delete it.
  - **Load-bearing pre-check (do before relying on the rearchitecture base):** confirm the worker update loop is alive after the `requestAnimationFrame`→`setTimeout` shim fix — i.e. clicking produces `[scene] [sceneWorker] message received` / `crdt-renderer-push applied` lines (sit need not visually play). Phase 1's parity assertions compare the typed projection against a *live* worker engine; if the loop is dead, those comparisons are meaningless. This one-bit confirmation gates starting Phase 1, not Phase 0.
- **Skinned-mesh instancing.** `InstancedMesh` cannot share skeletons; avatars/animated GLBs must keep `SkeletonUtils.clone`. Need a reliable classifier (does the GLB contain `SkinnedMesh`/animations?) to pick the path, plus the existing `installSkinnedMeshSafetyPatch` bounding-sphere guard.
- **Asset-pack Triggers / pointer ancestor resolution.** `PointerEventsSystem.resolvePointerResultEntity` / `collectPointerResultTargets` walk the parent chain because asset-pack registers `onPointerDown` on a parent Triggers entity while the raycast hits a child collider. The `ProjectionView` must expose parent/`Transform` lookups efficiently so this keeps working.
- **Value-set component semantics.** `PointerEventsResult`/`AvatarEmoteCommand` are append/grow-only (`addValue`). The projection's encoder must reproduce the SDK's value-set CRDT framing (per-entry timestamps) exactly, or scenes will drop events.
- **Diff completeness.** A diff consumer is only correct if no mutation is missed. Need a safety full-resync (cheap, periodic, or on scene-ready) during hydration, and careful handling of reparenting (`Transform.parent` changes must reparent the `THREE.Group`).
- **Snapshot vs delta race on composite-first.** Confirm initial `crdtGetState`/composite entities and the first script deltas converge correctly under Lamport LWW (renderer must not stamp snapshot data with timestamps that shadow later scene writes).
- **Multi-scene resource scoping.** Comms rooms, physics colliders, pointer/collision systems, and the asset cache are currently single-scene-shaped in `World.ts`. The scheduler must scope or share these deliberately (asset cache shared session-wide; physics/pointer scoped to active scene).
- **Memory under LRU eviction.** Evicting distant scenes must dispose `THREE.Group`s and instance handles without evicting still-referenced shared GLB prototypes from `AssetCache`.

---

## Appendix A — Symbols slated for change

- Replace: `CrdtMirror` (`engine`, `applyIncoming`, `flushOutgoing`, `getState`, `configureSpawn`) → `CrdtProjection` (Phase 1) → write path of `EntityStore` (Phase 4).
- Replace: `registerMirrorComponents` engine-bound defs → serializer registry.
- Rewrite: `ThreeBridge.sync(engine)` → `consumeDiff(diff, view)` (Phase 2) → in-place `Object3D` mutation in `EntityStore.apply` (Phase 4); `getHydrationStats(engine)` → store-backed.
- New: `EntityStore` (Three.js-backed, `owner`-tagged records, `apply(crdt)`, `upsertAvatar(...)`, `queueOutbound(...)`, change-notification subscriptions).
- Adapt: avatar pipeline (`AvatarShapeBridge`/`RemoteAvatarManager`/`AvatarComposer`) to register/update avatars as `owner:'avatar'` store entities (Phase 5); keep wearable/skeleton build.
- Add: `AssetCache` instancing path; clone-policy classifier (skinned avatar bodies excluded).
- Adapt: `PointerEventsSystem` (engine/ecs → `ProjectionView`/store read facade, `writeResult` → outbound queue).
- Adapt: `sceneHydration.waitForSceneAssets` pump target.
- Simplify (gated): `SceneScriptSystem` pointer-stash machinery; `sceneWorker` `rendererPushQueue`/`resolveRendererTransport`; `types.ts` `crdt-renderer-push*` / `crdt-round-trip-nudge`.
- New: `SceneScheduler` (multi-scene), composite-first boot path.
- **Frozen (do not touch):** `sceneWorker.ts` runtime, `evaluateSceneBundle`, `~system/*` stubs in `createSystemStubs.ts`, comms/RFC4, content resolution, identity.
