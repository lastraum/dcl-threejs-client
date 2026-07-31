# Scene layers plan — PX as second full scene

> **Branch:** `yoga-revamp` (v1.7 base + Scene UI COD)  
> **Status:** law landed · A–D **not** implemented on tip (re-author; do not merge old PX WIP)  
> **Platform law:** [PORTABLE_EXPERIENCE_COD.md](./PORTABLE_EXPERIENCE_COD.md)  
> **Abbreviation:** portable experience = **PX** (not PX — PX is PointerEvents). Code ids may still say `pe` / `PortableExperience*`.  
> **Bar:** [cod_prompt.md](./cod_prompt.md)  
> **Scope:** Make primary / PX / secondary **symmetric layers** for worker registration + **player ownership claims** — without rewriting PX lifecycle or scene UI.  
> **Related:** [`src/dcl/multiScene/`](../src/dcl/multiScene/) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md)

---

## 0. What this is / is not

### Is

- Phased, shippable path **A → D** so PX is a **double scene** (same features, no parcel bounds).  
- Reuse: `SceneWorkerSlot`, `PrivilegedIntentArbiter`, `InputHub`, `MultiSceneRuntime`, `PortableExperienceManager`, `SCENE_WORKER_PRIORITY`.  
- Small PRs; each phase leaves the client playable.

### Is not

- Full client rewrite.  
- PX rewrite (no new worker model; keep `SceneScriptSystem`).  
- Making PX “become main” or demoting genesis primary.  
- Inverting InputHub to primary-only keys.  
- Merging `lastraum` / `wip/pe-drone-input-ui-flash` as product code.

### One sentence

**Keep layers for workers; finish layers for player ownership (claims), then delete PX-only hacks.**

---

## 1. Current gap (yoga tip)

| Piece | Status |
|-------|--------|
| Kinds + priority | ✅ `types.ts` |
| Slot + phys offset | ✅ |
| PX lifecycle / consent / HUD | ✅ **keep** |
| Discrete intents | ✅ arbiter |
| Input fan-out | ✅ |
| PX full-rate interval | ✅ `peTickIntervalMs = 0` |
| PX UI root + SCENE_UI_COD | ✅ root differs only |
| SceneLayerRegistry | ❌ |
| PlayerClaimMerger | ❌ → `PeMainThreadMirror` instead |
| HostPoseMode | ❌ → pin fights free-flight |
| Unified continuous tick | ❌ → `runPeVehicleInputPump` |

**Slots are layered; PlayerSystem is still a primary god object that PX hacks into.**

---

## 2. Target architecture

See [PORTABLE_EXPERIENCE_COD.md](./PORTABLE_EXPERIENCE_COD.md) diagram.

```text
InputHub → all layers
SceneLayerRegistry → claims → PlayerHost → one avatar/camera
HostPoseMode: host_feet | host_pin | layer_drive
```

---

## 3. Phases

### Phase A — Scene layer registry (behavior-preserving)

**Goal:** Every running scene is a registry entry; **no player behavior change**.

1. Add `src/dcl/multiScene/SceneLayerRegistry.ts`.  
2. Register primary on load / rebind; PX on enable; secondary on boot; unregister on dispose.  
3. Log once on change: `[layers] registry n=… kinds=…`.  
4. Optional: rAF helpers use `registry.list()` without changing order of side effects.

**Files:** `SceneLayerRegistry.ts` · `MultiSceneRuntime.ts` · `PortableExperienceManager.ts` · `SecondaryLiveManager.ts` · `World.ts` · `index.ts`

**Exit:** promote/demote/PX enable keep registry sync; Genesis walk + PX enable unchanged.

---

### Phase B — Continuous claims

**Goal:** Replace PX-only mirror with layer claims applied once per frame.

| Claim | Host applies |
|-------|--------------|
| locomotion | freeze/clear WASD — **not** auto pin |
| camera | VC bridge winner |
| poseDrive | free-flight ownership flag |
| force / impulse | PhysicsCombined* + Lamport |
| discrete | keep arbiter |

1. `PlayerClaimMerger.ts` → `PlayerHostClaims`.  
2. `World.applyLayerPlayerClaims()` replaces `applyPeMainThreadMirror` + PX branch of VC select.  
3. Shrink then delete `PeMainThreadMirror`.  
4. PlayerSystem consumes claims — no `isAvatarLocomotionFrozenByPe` on the capsule path.

**Exit:** Neurolink freeze without PX-named PlayerSystem APIs; primary IM wins; plaza bounce once; PX VC when bound.

---

### Phase C — Unify continuous engine tick

**Goal:** Same tick class for PX as primary.

1. Audit `sceneWorker.ts` for `portableExperienceWorker` **quality** forks.  
2. Kill `runPeVehicleInputPump` product path → reassert + `requestSceneEngineTick`.  
3. Pointer residual must not starve PX `engine.update`.  
4. PX loading UI advances without key spam.

**Exit:** no PX-only continuous scheduler; SpaceRunner Gltf FINISHED still clears freeze-watch.

---

### Phase D — HostPoseMode + kill-list

**Goal:** Pose ownership enum; delete free-flight pin fights.

```ts
type HostPoseMode = 'host_feet' | 'host_pin' | 'layer_drive'
```

1. Map claims → mode (`layer_drive` only if **poseDrive + freeze**).  
2. `ReservedEntitiesSync` / inject: skip host PX/Camera stomp on `layer_drive`.  
3. PlayerSystem: pin **only** `host_pin`; follow layer feet on `layer_drive`.  
4. Execute kill-list in [PORTABLE_EXPERIENCE_COD.md](./PORTABLE_EXPERIENCE_COD.md).

**Exit:** Neurolink WASD moves drone; no `disableAll pinned` spam in free-flight; SpaceRunner still pins; sit/mode freeze escapeable.

---

### Phase E — Parity bridges (full double scene)

**Goal:** Close host-surface gaps that A–D do not touch. **A–D green ≠ AAA.**

1. Unified `wireSceneRuntimeToMainThread(system, { kind, physOffset })` for primary + PX.  
2. AvatarAttach resolvers for PX — survive parcel promote/demote.  
3. Spatial audio root on PX.  
4. signedFetch with **PX scene identity**.  
5. Full restricted surface (NFT, clipboard, setCameraTransform, scene emote).  
6. Offset-aware PX collider PART/ROOT slides.  
7. Multiplayer / scene-room for PX **or** fail-loud stubs (exception #4 closed with support preferred).  
8. Multi-PX: per-id UI roots if cap > 1.

**Exit:** smoke rows for attach, signedFetch, media-on-secondary-stand, multi-PX dispose sibling, freecam after VC unbind all green.

---

## 4. Dependency graph

```text
PORTABLE_EXPERIENCE_COD + this plan
        │
        ▼
   A registry ──► B claims ──► C unify tick ──► D HostPoseMode + kill-list ──► E parity bridges
```

C is **mandatory after B** (freeze claims exist). SCENE_UI_COD portable HUD polish may parallel A–B if it only touches `src/ui/scene/*`.

---

## 5. Smoke matrix

| Scenario | A | B | C | D |
|----------|---|---|---|---|
| Genesis road walk | ✓ | ✓ | ✓ | ✓ |
| Enable Neurolink / smart wearable PX | ✓ | ✓ | ✓ | ✓ |
| Free-flight WASD + camera | | ✓ | ✓ | ✓ |
| PX loading message clears | | | ✓ | ✓ |
| PX HUD open + primary walk | ✓ | ✓ | ✓ | ✓ |
| Primary IM freeze | | ✓ | | ✓ |
| SpaceRunner pin | | | | ✓ |
| Plaza bounce impulse | | ✓ | | ✓ |
| Two-PX cap / disable | ✓ | ✓ | | ✓ |
| Promote with PX running | ✓ | ✓ | | ✓ |

**Human test before merge.** COD: if free-flight, HUD, walk, pin, or bounce fail — do not merge; no `if (pe)` bandaids.

---

## 6. DevTools oracles

- `[layers] registry n=… kinds=…`  
- `[layers] locomotion|camera|poseDrive claim…` (on change)  
- `[layers] HostPoseMode → host_feet|host_pin|layer_drive`  
- Absence of continuous `disableAll pinned` during free-flight  
- Hub `pressed=` non-empty while holding W in free-flight  

---

## 7. Risk register (harsh critic)

| Risk | Failure | Mitigation |
|------|---------|------------|
| disableAll = pin | Drone stuck | D: freeze ≠ pin |
| Claim desync unload | Stuck freeze | Unregister clears; re-merge every frame |
| VC thrash | Lens flicker | Stable winner while bound |
| Impulse double-fire | Bounce ×2 | Lamport across layers |
| UI dual layout invent | Flash / wrong size | SCENE_UI_COD only |
| InputHub primary-only mistake | Dead keys | Non-goal |
| Secondary claim leak | Neighbor freezes player | Ignore secondary for loc/cam/pose |
| Phys thrash | Soft floor | STATIC_COLLIDER_COD + registered ids |

---

## 8. Sealed decisions (not open)

| Decision | Law |
|----------|-----|
| PX bound MainCamera vs freecam | PX bound **wins** over unbound primary freecam |
| `layer_drive` follow | **Always follow feet**; VC drives lens |
| Claim sample / order | Hard order in PORTABLE_EXPERIENCE_COD (merge before capsule apply) |
| Multi-PX locomotion | Prefer freeze; else higher priority / latest |
| AvatarModifier / CameraMode | Full scene power via claims (prio 50); primary wins ties |
| After B | No new `*ByPe*` / `PeMainThread*` APIs |

**Anti-merge:** reimplement against yoga tip APIs only. Do not cherry-pick `PeMainThreadMirror` growth, pump forks, or pre-yoga SceneUi flash patches from old branches.

---

## 9. Success definition

1. Primary and PX are **registry entries**.  
2. Freeze / camera / free-flight go through **claim merge**, not PX-named host APIs.  
3. Continuous ticks are **layer policy**, not PX-only product.  
4. Free-flight pin hacks **deleted** for `HostPoseMode`.  
5. PX UI is **SCENE_UI_COD-identical** (root id only).  
6. PX colliders obey **STATIC_COLLIDER_COD**.  
7. Phase **E** parity bridges green (attach, signedFetch, restricted, multi-PX UI, multiplayer or fail-loud).  
8. Full smoke matrix in PORTABLE_EXPERIENCE_COD — no PX special-case regrowth.

---

## 10. Doc history

| Date | Note |
|------|------|
| 2026-07-22 | Initial design on `lastraum` (reference only) |
| 2026-07-31 | Relanded on `yoga-revamp` as law + plan under COD; product = double scene, no bounds; abbreviate **PX** not PX |
