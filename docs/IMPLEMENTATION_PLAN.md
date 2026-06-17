# Three.js DCL SDK7 Client — Implementation Plan

> Browser-native Decentraland client: load deployed Worlds/scenes, shim SDK7 runtime, mirror ECS → Three.js, expand to open world.

**Status:** Explorer **layout parity ✅** on RickRoll-style worlds; Phase 5 **social comms** next (see [`PROGRESS.md`](./PROGRESS.md))  
**ECS reference:** [`ECS_COMPONENTS.md`](./ECS_COMPONENTS.md) — all SDK7 components by phase  
**Related repos in workspace:** `dcl-companion` (content resolution), `dcl-avatar-hyperfy` (VRM/Three.js), `colyseus-scene` (multiplayer), `blank-scene` (test deploy)

---

## Goal

Build a **browser-native Decentraland client** that:

1. Loads a deployed **World** or **parcel scene** from content servers
2. Executes `bin/scene.js` (or `bin/index.js`) via a **runtime shim**
3. Mirrors ECS component state into a **Three.js scene graph**
4. Expands over time to locomotion, avatars, networking, and multi-scene open world

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│ Main Thread (Browser)                                       │
│  React HUD / Chat │ Three.js Renderer │ Input / Camera        │
│  ThreeBridge (ECS → Object3D) │ DclLoader (fetch + boot)    │
└───────────────────────────┬─────────────────────────────────┘
                            │ postMessage (ECS deltas)
┌───────────────────────────▼─────────────────────────────────┐
│ Web Worker (Phase 1+)                                       │
│  DclShim (fake engine + ~system/*) │ scene.js execution     │
│  ECS store │ systems loop (onUpdate dt)                       │
└───────────────────────────┬─────────────────────────────────┘
                            │ fetch
┌───────────────────────────▼─────────────────────────────────┐
│ Content Servers                                             │
│  worlds-content-server │ peer.decentraland.org (catalyst)   │
│  asset-bundle-registry (optional, Phase 6+)                 │
└─────────────────────────────────────────────────────────────┘
```

### Core design principle

The bundled scene does **not** talk to Three.js directly. It talks to a **fake DCL runtime** (shim). The shim records ECS mutations and posts them to the main thread, where `ThreeBridge` turns them into meshes, lights, animations, and UI.

This matches how Hyperfy, Bevy explorer, and custom viewers bootstrap DCL scenes.

### Reference parity (implementation principle)

When adding runtime, rendering, physics, comms, or asset-streaming behavior, **mirror the Unity Foundation Client / DCL Explorer** as closely as practical:

- **WASM & wire formats** — PhysX integration patterns, RFC4 comms codecs (see `.cursor/rules/comms-architecture.mdc`, `PROGRESS.md`)
- **Three.js rendering** — reuse optimizations and scene-graph patterns from reference clients (Unity Explorer, Hyperfy, dcl-companion) where they match shipped Explorer behavior
- **LOD, streaming, camera** — load budgets, distance/visibility culling, and third-person camera collision should target Explorer parity unless a deliberate MVP shortcut is documented here or in `WORLD_ENVIRONMENT.md`
- **Deferred — third-person jitter:** User-confirmed stutter is **orbital camera lerp + alpha-tested tree foliage** (FPV is smooth). Not sync-frame physics or LOD — revisit camera smoothing / foliage depth later (see `PROGRESS.md`).

Document intentional divergences (e.g. glTF grass scatter vs `GrassIndirectRenderer`) so they can be revisited against the Unity source.

---

## Two loading strategies (use both, in order)


| Strategy                   | When                     | Fidelity                  | Effort        |
| -------------------------- | ------------------------ | ------------------------- | ------------- |
| **A. Static asset viewer** | Phase 0 — prove pipeline | Builder-placed glTFs only | Low           |
| **B. Shim + scene.js**     | Phase 1+ — real scenes   | Full scene logic          | Medium → High |


**Phase 0** validates content URLs, parcel bounds, and glTF loading without fighting the full runtime.  
**Phase 1** runs `main()` from the bundle and grows the shim until scenes render correctly.

Most SDK7 scenes require **B** because builder exports and runtime logic live inside `bin/scene.js`.

---

## Content resolution (reuse from `dcl-companion`)

Port client-side logic from `dcl-companion/server/src/catalyst.ts`.

### Worlds (single-scene MVP target)

```
GET https://worlds-content-server.decentraland.org/world/{worldName.dcl.eth}/about
  → configurations.scenesUrn[0]
  → urn:decentraland:entity:{entityId}

GET https://worlds-content-server.decentraland.org/world/{worldName}/scenes
  → entity metadata, content[], baseUrl

Asset URL: {baseUrl}/contents/{hash}
```

### Parcels (open-world expansion)

```
GET https://peer.decentraland.org/content/entities/wearables/?pointer=80,-1
  → filter type === "scene"
  → pick newest by timestamp

Asset URL: https://peer.decentraland.org/content/contents/{hash}
```

### Important details

- **Main entry:** `content.find(f => f.file === 'bin/scene.js' || f.file === 'bin/index.js')` — also check `scene.json.main`
- **scene.json** lives inside entity `metadata` (parsed JSON), not always as a separate file
- **Spawn points / parcels / bounds** come from metadata → drive camera + world limits
- **Coordinate system:** see [Scene coordinate system](#scene-coordinate-system) below

---

## Scene coordinate system

**Rule: the south-west (SW) corner of the scene is always `(0, 0, 0)` in scene space.**


| Concept                      | Convention                                                                                         |
| ---------------------------- | -------------------------------------------------------------------------------------------------- |
| **Origin**                   | SW corner of `scene.base` parcel (not center)                                                      |
| **Parcel size**              | 16 m × 16 m                                                                                        |
| **+X**                       | East (increasing parcel **x** on the map)                                                          |
| **+Y**                       | Up (height)                                                                                        |
| **+Z**                       | North (increasing parcel **y** on the map)                                                         |
| **Entity / spawn positions** | Meters relative to that origin — e.g. spawn `(8, 0, 8)` is the center of a 1×1 scene on base `0,0` |
| **Parcel world placement**   | SW corner of parcel `(px, py)` at `((px - baseX) × 16, 0, (py - baseY) × 16)`                      |


Do **not** center the scene on the origin or use parcel centers as `(0,0)`. All layout, landscape, physics, and ECS→Three.js bridging must use the SW-corner origin so coordinates match SDK7 / Explorer.

### Three.js render boundary (handedness)

DCL ECS transforms are **left-handed**; Three.js is **right-handed** with the same +X / +Y / +Z labels. Do **not** copy position/quaternion bytes directly onto `Object3D` — use `src/bridge/dclTransform.ts`:

- **Position:** `x_three = -x_dcl` (Y, Z unchanged)
- **Quaternion:** `(-x, y, z, -w)` under YZ reflection
- **Logical space** (PhysX simulation coords after spawn conversion, comms wire, minimap, CRDT mirror writes): DCL meters
- **Display space** (Three.js meshes, camera follow, remote avatar roots): converted via `dclToThree*`

Never fix mirroring with `scale.x = -1` on a scene root — it breaks lighting and backface culling.

### Phase 0 test layout

Default template is **1×1** (`parcels: ["0,0"]`, `base: "0,0"`). Expand to multi-parcel scenes by reading deployed `scene.json` metadata.

### Landscape padding (client environment)

Explorer draws empty land **around** the deployed footprint. We mirror that with a **one-parcel-wide ring** on every side of the scene’s axis-aligned bounds (including corners):

```
  (-1,1) (0,1) (1,1)
  (-1,0) (0,0) (1,0)   ← (0,0) = scene parcel for 1×1 test
  (-1,-1)(0,-1)(1,-1)
```

- **Scene parcels:** from `metadata.scene.parcels` — scene content + ground live here
- **Padding parcels:** every cell in the expanded bbox not required to be in the deploy, but we still render `ground.glb` + trees/bushes

Implemented in `src/dcl/landscape/Utils/ParcelGrid.ts` → `landscapeParcelKeys(sceneParcels, padding: 1)`.

---

## Project structure (mirrors Unity Explorer `DCL/` layout)

```
ThreejsClient/src/
├── client/
│   ├── bootstrap.ts              # entry orchestration
│   └── ui/Compass.ts             # scene compass HUD
├── core/
│   ├── World.ts                  # client world root
│   └── systems/
│       └── LandscapeSystem.ts    # loads terrain + decoration
├── dcl/                          # ↔ Explorer/Assets/DCL/
│   ├── content/
│   │   ├── resolveScene.ts
│   │   ├── parseParcel.ts
│   │   └── types.ts
│   └── landscape/                # ↔ DCL/Landscape/
│       ├── Data/
│       │   └── EmptyLandCatalog.ts
│       ├── Utils/
│       │   ├── ParcelGrid.ts
│       │   ├── SceneSpace.ts     # SW-corner coords + ground offset
│       │   └── SeededRandom.ts
│       ├── Worlds/
│       │   └── TerrainModel.ts   # ↔ TerrainModel.cs (padding bounds)
│       ├── Systems/
│       │   └── RenderGroundSystem.ts  # ↔ RenderGroundSystem.cs
│       └── ParcelDecorator.ts    # trees/bushes/rocks/grass scatter
├── rendering/
│   ├── AssetCache.ts
│   ├── DclTextureResolver.ts     # external glTF texture → Catalyst hash
│   ├── LandscapeAssetSanitizer.ts # strip colliders, tune foliage materials
│   └── SceneHost.ts
└── main.ts
```

### Unity Explorer mapping


| Unity Explorer                                        | Three.js client                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `DCL/Landscape/Worlds/TerrainModel.cs`                | `dcl/landscape/Worlds/TerrainModel.ts`                                                |
| `DCL/Landscape/Worlds/WorldTerrainGenerator.cs`       | `LandscapeSystem` + `RenderGroundSystem`                                              |
| `DCL/Landscape/TreeData.cs` (baked `WorldsTrees.bin`) | `ParcelDecorator` + parcel-seeded RNG                                                 |
| `DCL/Landscape/Systems/RenderGroundSystem.cs`         | ground + glTF grass patches                                                           |
| `GrassIndirectRenderer` (GPU grass)                   | `EmptyLandCatalog.grass` glTF scatter (MVP)                                           |
| Occupied parcels skip trees                           | `scene` role: ground only; `padding`: full props                                      |
| External glTF textures                                | `DclTextureResolver.ts` maps filenames → Catalyst hashes (e.g. `FanstasyPack_TX.png`) |
| Scene compass                                         | HUD top-right; +X east, +Z north, rotates with camera                                 |


---

## Phase 0 — Static world viewer ✅

**Outcome:** Load `your-world.dcl.eth`, show landscape + glTFs, orbit camera, correct bounds.

**Progress:** See `[PROGRESS.md](./PROGRESS.md)` for full checklist and session notes.

### Steps

1. **Scaffold** — Vite + TypeScript + Three.js r16x ✅
2. `**resolveScene.ts`** — Port catalyst helpers from `dcl-companion` ✅
3. `**AssetCache.ts**` — `GLTFLoader` + dedup by hash + DRACO ✅
4. `**RenderGroundSystem.ts**` — `ground.glb` per parcel + padding ring ✅
5. `**ParcelGrid` / `SceneSpace**` — SW-corner origin + ground ±8 offset ✅
6. `**main.ts**` — Renderer, orbit controls, spawn at default spawn point ✅
7. `**DclTextureResolver**` — shared external textures ✅
8. `**LandscapeAssetSanitizer**` — collider strip + foliage ✅
9. `**Compass` HUD** — orientation overlay ✅

### Success criteria

- [x] World loads from path `/name.dcl.eth` or legacy `?world=`
- [x] Parcel ground blocks render under scene + padding ring
- [x] glTF assets load without texture 404 (shared atlas resolver)
- [x] Stable orbit viewer on static landscape (FPS stats HUD)
- [ ] Side-by-side visual parity vs Explorer (QA pending)

---

## Phase 1 — ECS shim + scene.js execution ✅ **CLOSED**

**Outcome:** Run `bin/scene.js`; static + dynamically spawned entities appear with Explorer-aligned transforms and primitives.

> **Full component matrix:** [`docs/ECS_COMPONENTS.md`](./ECS_COMPONENTS.md) — all 60+ SDK7 components mapped to phases.  
> **Code registry:** `src/dcl/ecs/registry.ts`

### Architecture

```
┌──────────────────── Main thread ────────────────────┐
│ LandscapeSystem │ SceneHost │ CrdtMirror (@dcl/ecs)   │
│ ThreeBridge (Transform/Gltf/Mesh/Material/Visible)  │
└────────────────────────▲──────────────────────────────┘
                         │ postMessage CRDT RPC
┌────────────────────────┴──────────────────────────────┐
│ sceneWorker.ts — eval bin/index.js + ~system stubs    │
└───────────────────────────────────────────────────────┘
```

### Phase 1 ECS components (P0 render)

| Component | Bridge | Status |
|-----------|--------|--------|
| Transform | `THREE.Group` hierarchy + depth-sorted parents | ✅ |
| GltfContainer | `AssetCache` + hash resolve | ✅ Genesis Plaza, RickRoll, parcels |
| MeshRenderer | Box/sphere/plane/cylinder primitives | ✅ planes vertical + double-sided |
| Material | PBR/unlit + textures + alpha | ✅ |
| VisibilityComponent | `visible` flag | ✅ wired in `ThreeBridge` |

**Phase 1b** (next after P0): LightSource, TextShape, Animator, Billboard — see ECS doc.

### ~system stubs (Phase 1)

| Module | Status |
|--------|--------|
| `~system/EngineApi` | 🟢 `crdtSendToRenderer`, `crdtGetState`, **`sendBatch` / `subscribe` / `unsubscribe` ✅** (comms queue) |
| `~system/Runtime` | ✅ `getSceneInformation`, `getRealm` |
| `~system/RestrictedActions` | 🟡 `movePlayerTo` ✅, `triggerEmote` ✅, **`openExternalUrl` ✅** — **`openNftDialog` ⬜ no-op** |
| `~system/CommunicationsController` | 🟢 `sendBinary` ✅ · **`send` ✅** (topic `comms`) |
| `~system/UserIdentity` | ✅ `getUserData` RPC (+ mirror ECS for `getPlayer()`) |
| `~system/CommsApi` | 🟡 topics wired — **`getActiveVideoStreams` ⬜ no-op** |
| `~system/SignedFetch` | 🟢 `signedFetch` + `getHeaders` via worker RPC → main thread |

### Steps

1. **CrdtMirror** — `@dcl/ecs` renderer transport ✅
2. **sceneWorker** — fetch + eval bundle + system stubs ✅
3. **ThreeBridge** — P0 components → Three.js ✅
4. **SceneScriptSystem** — wire into `World` ✅
5. Validate on `/rickroll.dcl.eth` ✅
6. Transform + primitive fidelity (planes, avatars) ✅
7. Phase 1b components ⬜ **next**

### Success criteria

- [x] `bin/scene.js` / `bin/index.js` boots without fatal `require` errors
- [x] CRDT populates mirror engine (entities > root)
- [x] Scene meshes visible above landscape
- [x] No fatal errors on RickRoll world
- [x] Transform + MeshRenderer parity vs Explorer (planes, NPC facing)

---

## ECS components — phase map (summary)

See **[`docs/ECS_COMPONENTS.md`](./ECS_COMPONENTS.md)** for the complete table. Quick reference:

| Phase | Components |
|-------|------------|
| **1** | Transform, Visibility, GltfContainer, MeshRenderer, Material, Name, Tags |
| **1b** | LightSource, TextShape, Animator, Billboard, GltfContainerLoadingState |
| **2** | MeshCollider, PointerLock, MainCamera, AvatarLocomotionSettings |
| **3** | PointerEvents*, Raycast*, TriggerArea*, Ui*, Audio*, Video*, Tween*, VirtualCamera, SkyboxTime, InputModifier |
| **4** | AvatarShape, AvatarBase, AvatarAttach, AvatarEmoteCommand, AvatarModifierArea, PlayerIdentityData* |
| **5** | NetworkEntity, NetworkParent, SyncComponents |
| **6** | ParticleSystem, NftShape, Physics*, AssetLoad*, MapPin, GltfNodeModifiers, EngineInfo*, RealmInfo* |

\* *Result / client-only components are produced by the client back toward the scene script.*

---

## Phase 1 (legacy notes — superseded by above)

<details>
<summary>Original Phase 1 draft</summary>

### Minimal engine shim (P0)

Bundled scenes ship their own `@dcl/ecs` engine; we mirror CRDT on main via `EngineApi`.

**Lifecycle:** SDK7 exports `export function main()`; older bundles self-start on eval.

</details>

## Phase 2 — Input, locomotion, collisions (Weeks 5–6)

- PointerLockControls / FPS controller
- `MeshCollider` → **PhysX** (static actors; port from `dcl-avatar-hyperfy`) + `PxCapsuleController` for player
- Scene bounds clamp from parcel AABB
- `RestrictedActions.movePlayerTo` stub

---

## Phase 3 — Interactivity + UI (Weeks 7–8)

- `PointerEvents` + raycasting
- `TriggerArea`, `UiTransform`/`UiText` → DOM or render-to-texture
- `VideoPlayer`, `AudioStream`, `Tween`, `VirtualCamera`

---

## Phase 4 — Avatars + identity (Weeks 9–10)

- VRM loader (from `dcl-avatar-hyperfy`)
- `AvatarShape`, wearables, emotes
- Optional wallet via companion auth patterns

---

## Phase 5 — Multiplayer + chat (Weeks 11–13)

- Colyseus (`colyseus-scene`)
- LiveKit (`dcl-companion/web-app-social`)
- Sync Transform + AvatarShape at 10–20 Hz for MVP

---

## Phase 6 — Open world expansion (Week 14+)

- Parcel grid loader with load/unload radius
- Global asset cache across scenes
- Instancing, LOD, frustum culling
- Asset Bundle Registry for converted glTFs
- Unified `resolveScene(pointer)` for Genesis + Worlds

---

## Client environment / landscape (critical — not in scene deploy)

The red grass parcel block, cliff edges, scattered bushes, and stylized trees in Explorer are **client-side landscape**, toggled via Creator Hub **"Landscape Terrain Enabled"**. They are **not** part of the scene entity (`bin/scene.js`).

See `**docs/WORLD_ENVIRONMENT.md`** for asset hashes and placement strategy.

**MVP scope (no sand/water/clouds):**

- `ground.glb` per **scene parcel + 1-parcel padding ring** around the footprint
- Procedural tree/bush placement from `@dcl/asset-packs` "empty land" category
- **Phase 0 default:** 1×1 scene at `0,0` → 3×3 landscape grid (9 parcels)
- Skip ocean, distant sand, sky clouds until Phase 6

---

## Performance checklist


| Area          | Tactic                                        |
| ------------- | --------------------------------------------- |
| Asset loading | Dedup by hash; DRACO/KTX2                     |
| postMessage   | Batch ECS deltas                              |
| Rendering     | Merge static meshes per parcel where possible |
| Landscape     | InstancedMesh for repeated bushes             |
| Memory        | dispose() on parcel unload; LRU cache         |


---

## Immediate next steps

| # | Task | Phase | Est. |
|---|------|-------|------|
| 1 | **`PointerEvents` + camera raycast** — click/hover on scene entities | 3 | 2–3 days |
| 2 | **`LightSource` ECS** — scene-authored point/spot/directional lights | 1b | 1 day |
| 3 | **`TextShape` + `Billboard`** — world labels and billboards | 1b | 1 day |
| 4 | **`movePlayerTo` + parcel clamp** — scene player APIs | 2b | 1 day |
| 5 | ~~**Validate GltfContainer / Visibility** on glTF-heavy world~~ | 1 | ✅ |
| 6 | **`UiTransform` / `UiText`** — basic in-world UI | 3 | 2 days |

**Completed Phase 0–1 tasks** are archived in [`PROGRESS.md`](./PROGRESS.md).

---

## Key risks


| Risk                                      | Mitigation                                              |
| ----------------------------------------- | ------------------------------------------------------- |
| Unknown `~system/*` imports               | Stub + log; scan top worlds                             |
| SDK version mismatch                      | Pin `@dcl/sdk` versions or minimal math shim            |
| Landscape placement differs from Explorer | Match `@dcl/asset-packs` assets first; refine RNG later |
| CORS on catalyst                          | Worlds-content-server is CORS-friendly; proxy if needed |


---

## Definition of done — Single-scene MVP

- [x] Enter world via URL (landscape + layout metadata)
- [x] Parcel ground + trees render (client environment)
- [x] Scene script runs without fatal errors
- [x] Transform, MeshRenderer, Material work (primitives + avatars)
- [x] GltfContainer + Visibility validated on glTF world (Genesis Plaza, RickRoll, parcels)
- [x] Player spawns at default spawn point
- [x] FPS movement + basic collision
- [x] Loading progress UI + debug overlay (Help toggle)
- [ ] PointerEvents / scene interactivity

---

## Grok starter corrections

1. Lifecycle: `**export function main()`**, not `onStart`
2. Entry: check `**bin/index.js**` as well as `bin/scene.js`
3. Asset paths: worlds `/contents/{hash}`, catalyst `/content/contents/{hash}`
4. Shim in worker, **Three.js on main thread**
5. Mirror full ECS API: `.create()`, `.getMutable()`, `.createOrReplace()`

