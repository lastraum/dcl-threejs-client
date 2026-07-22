# Scene layers recovery plan (incremental)

> **Branch:** `lastraum` · **Status:** Phases A–D implemented on working tree (test before commit)  
> **Scope:** Recover the multi-scene **layer** architecture that already exists in skeleton form — without a client rewrite and without rewriting PE.  
> **Related:** [`src/dcl/multiScene/`](../src/dcl/multiScene/) · [ARCHITECTURE.md](./ARCHITECTURE.md) · [INTEGRATION.md](./INTEGRATION.md)

---

## 0. What this is / is not

### Is

- A **phased, shippable** path (A → D) to make primary / PE / secondary behave as **symmetric scene layers** feeding one **PlayerHost**.
- Reuse of existing pieces: `SceneWorkerSlot`, `PrivilegedIntentArbiter`, `InputHub`, `MultiSceneRuntime`, `SCENE_WORKER_PRIORITY`.
- Small PRs that can land independently; each phase leaves the client playable.

### Is not

- A **full client rewrite**.
- A **PE rewrite** (no new PE runtime, no new worker model, no dropping `SceneScriptSystem`).
- Making PE “become main” or demoting genesis primary.
- Inverting InputHub so only primary gets keys (that breaks multi-PE and re-centralizes wrong).

### One sentence

**Keep layers for workers; finish layers for player ownership (claims), then delete PE-only hacks into that model.**

---

## 1. Current state (why it feels broken)

### Layer skeleton (already built)

| Piece | Location | Role |
|--------|----------|------|
| Kinds + priority | `multiScene/types.ts` | `primary` 100 · `pe` 50 · `secondary` 10 |
| Slot | `SceneWorkerSlot.ts` | Isolated `SceneScriptSystem` + phys offset + UI root |
| Runtime | `MultiSceneRuntime.ts` | PE + secondary; primary still `World.sceneScript` |
| Discrete intents | `PrivilegedIntentArbiter.ts` | movePlayer / teleport / emote |
| Input fan-out | `InputHub.ts` | Hardware → all subscribers |
| PE full-rate tick | `caps.ts` `peTickIntervalMs = 0` | PE must run every frame like primary |

### Gap (what never became a layer)

Continuous **player-affecting** state never joined the arbiter:

- `InputModifier` freeze → `PeMainThreadMirror` (PE-only copy onto primary)
- Free-flight pose → ad-hoc skip-feet / pin release / follow PE Transform
- VirtualCamera lens → `selectActiveVirtualCameraBridge` PE branch
- Engine continuous tick → ~~`runPeVehicleInputPump` PE-only fork~~ **deleted** — PE uses same `requestSceneEngineTick` as primary
- MOVE CAMERA dual latch / flight pump → **deleted** — freeze is live IM; free-flight is one platform path

So: **slots are layered; PlayerSystem is still a primary god object that PE hacks into.**

### Bug that motivated this doc

Neurolink-style PE free-flight: keys reach PE worker, IM freezes avatar, but host **re-pins feet** / re-injects reserved poses → drone stuck + loading UI can stall if PE ticks starve. Fixes on `lastraum` are temporary bridges; phases A–D retire them into policy.

---

## 2. Target architecture (end of D)

```text
                    ┌──────────────┐
   keyboard/pointer │  InputHub    │──► primary layer worker
                    │  (unchanged) │──► pe:* layer workers
                    └──────────────┘──► (secondary optional)

   ┌─ SceneLayerRegistry ─────────────────────────────┐
   │  primary · pe:urn… · secondary:entityId…         │
   │  each: SceneScriptSystem + kind + priority       │
   └──────────────────────┬────────────────────────────┘
                          │ continuous claims + discrete intents
                          ▼
                   ┌─────────────┐
                   │ PlayerHost  │  (thin World/PlayerSystem façade)
                   │ merge claims│
                   └──────┬──────┘
                          ▼
              capsule · freecam/VC · network transform
```

**Input direction:** host → layers (already correct).  
**Effect direction:** layers → host claims (finish this).  

Layers do **not** become main. Main is the **only subscriber** to player-world effects.

---

## 3. Phases overview

| Phase | Goal | Rewrite? | Risk | Suggested PR size |
|-------|------|----------|------|-------------------|
| **A** | Registry: primary is a layer | No | Low | Small |
| **B** | Continuous claims (IM / camera / pose / force) | No | Medium | Medium |
| **C** | Unify continuous engine tick | No | Medium | Medium |
| **D** | Pose ownership modes; delete PE special cases | No | Medium | Medium–large (mostly deletions) |

**Ship rule:** each phase merges only when genesis walk + one PE (Neurolink or similar) smoke still pass.

**No commits from agents until human tests** a given phase implementation (per project workflow).

---

## 4. Phase A — Scene layer registry

### Goal

Make “every running scene is a layer” **true in code**, without changing player behavior.

### Work

1. Add `SceneLayerRegistry` (or expand `MultiSceneRuntime`) with:
   ```ts
   type SceneLayer = {
     id: string              // 'primary' | pe urn | secondary entityId
     kind: SceneWorkerKind   // primary | pe | secondary
     system: SceneScriptSystem
     priority: number        // from SCENE_WORKER_PRIORITY
     physOffset?: number
   }
   ```
2. Register **primary** as `id: 'primary'` when World binds `sceneScript`.
3. Register PE / secondary from existing managers (they already own slots).
4. World rAF: optional `for (layer of registry) layer.system.…` only where today loops PE/primary separately — **behavior-preserving** first.
5. Log once: `[layers] registry n=… kinds=primary,pe`.

### Explicit non-goals

- No claim merge yet.
- No deleting `PeMainThreadMirror`.
- No InputHub changes.
- No changing PE UI root.

### Exit criteria

- [ ] `World` can list all running systems via registry alone.
- [ ] Promote / demote / PE enable-disable keep registry in sync.
- [ ] Play: genesis road + enable Neurolink still works as before this PR.

### Files likely touched

- `src/dcl/multiScene/MultiSceneRuntime.ts` (or new `SceneLayerRegistry.ts`)
- `src/core/World.ts` (register primary; query registry)
- `PortableExperienceManager.ts` / `SecondaryLiveManager.ts` (register/unregister)

---

## 5. Phase B — Continuous claims bus

### Goal

Replace PE-only mirroring with **layer claims** main applies once per frame.

### Claim types (extend arbiter or sibling `PlayerClaimMerger`)

| Claim | Source (per layer) | Host applies |
|--------|-------------------|--------------|
| `locomotion` | `InputModifier` on PlayerEntity | freeze/clear capsule WASD; **not** auto foot-pin |
| `camera` | `MainCamera.virtualCameraEntity` set | active `VirtualCameraBridge` = that layer’s bridge |
| `poseDrive` | free-flight / vehicle (IM freeze + scene owns motion) | host stops reserved feet inject to that layer; may follow PE pose |
| `force` / `impulse` | PhysicsCombined* | same as today’s mirror, claim-shaped |
| *(existing)* `movePlayer` / `teleport` / `emote` | RestrictedActions | keep `PrivilegedIntentArbiter` |

**Priority:** reuse `SCENE_WORKER_PRIORITY` (primary > pe > secondary). Same priority: latest timestamp wins (match arbiter).

### Work

1. Each frame after layers tick (or after worker `player-frame` applied):
   - collect claims from each layer’s projection.
2. Merge → single `PlayerHostSnapshot`.
3. Apply once:
   - PlayerSystem locomotion block / scene-owned motion flag
   - VC bridge selection (replace PE-special `selectActiveVirtualCameraBridge` body with “camera claim winner”)
   - force/impulse write to primary projection **or** direct PlayerSystem API
4. Implement `PeMainThreadMirror` as a **thin adapter** calling claim collect for PE only, then migrate primary into the same collector and delete the class.

### Explicit non-goals

- No new worker protocol if projection already has IM/MainCamera (prefer main-thread read of each layer’s ECS).
- No changing InputHub fan-out.
- No full pose-mode enum yet (that’s D); Phase B can set a boolean `poseDriveLayerId | null`.

### Exit criteria

- [ ] Neurolink freeze works **without** PE-named APIs in PlayerSystem (only claim results).
- [ ] Empty primary road + PE camera claim → lens on PE VC when bound.
- [ ] Primary scene with its own IM freeze still works (primary claim wins).
- [ ] Plaza bounce impulse still works (force/impulse claims).

### Files likely touched

- `PrivilegedIntentArbiter.ts` or new `PlayerClaimMerger.ts`
- `PeMainThreadMirror.ts` → shrink / delete
- `World.ts` apply path
- `PlayerSystem.ts` (consume snapshot, not PE checks)

---

## 6. Phase C — Unify continuous engine ticks

### Goal

**Same class of tick code for PE as primary.** No PE continuous-tick fork.

### Work (done)

1. PE already receives `play-frame-tick` every rAF (`peTickIntervalMs = 0` via `SceneWorkerSlot.tickSync`).
2. Deleted `runLayerContinuousTick` / `runPeVehicleInputPump` / PE early-return on `play-frame-tick`.
3. PE and primary both: reassert keys → `requestSceneEngineTick` (cooperative engine.update + UI dirty + poll).
4. Keyboard holds: InputHub `pump-scene-engine-tick` → same reassert + `scheduleSceneInputEngineTick` (no PE branch).
5. Secondary stays duty-cycled via `secondaryTickIntervalMs`.

### Explicit non-goals

- No new worker transport.
- No forcing secondary to full rate.
- Edit-flight MOVE CAMERA still uses dedicated `runSceneFlightPump` (primary unbound-VC tool path).

### Exit criteria

- [x] No PE-only engine scheduler in `sceneWorker`.
- [ ] PE loading UI advances without hammering keys (play-frame-tick rate).
- [ ] WASD free-flight / drone still feels responsive (hub pump + reassert).
- [ ] Primary SpaceRunner / Flagtag freeze-watch still sees Gltf FINISHED.

### Files

- `src/shim/worker/sceneWorker.ts`
- `src/core/systems/SceneScriptSystem.ts` (`tickPlayFrame` / pump)
- `src/dcl/multiScene/caps.ts` (`peTickIntervalMs = 0`)

---

## 7. Phase D — Pose ownership modes + delete special cases

### Goal

One host pose mode enum; remove temporary PE free-flight hacks that duplicate policy.

### Pose modes

```ts
type HostPoseMode =
  | 'host_feet'    // normal walk; host writes reserved Player/Camera to workers
  | 'host_pin'     // load-gate / fall-reset: pin capsule (SpaceRunner) — claim must request pin
  | 'layer_drive'  // winning layer owns Player/Camera Transform; host follows or lens-only
```

**Critical policy change (document + implement):**

- `InputModifier.disableAll` **alone** does **not** imply `host_pin`.
- `host_pin` only when claim says pin (or primary load-gate helper).
- PE free-flight = `locomotion` freeze + `poseDrive` → `layer_drive`.

### Work

1. Map claim merge → `HostPoseMode`.
2. Wire:
   - `ReservedEntitiesSync.prepareRendererRoundTrip({ skipPoses: mode === 'layer_drive' })`
   - `CrdtProjection.setAllowWorkerReservedTransforms(mode === 'layer_drive')`
   - worker inject skip reserved PE/Camera when layer owns (already partially present)
   - PlayerSystem: pin only on `host_pin`; follow layer feet on `layer_drive`
3. Delete or gut:
   - PE-only branches that only exist for free-flight pin fights
   - duplicate “scene-owned motion” flags if fully covered by mode
4. Update [ARCHITECTURE.md](./ARCHITECTURE.md) short section “Scene layers + PlayerHost”.

### Exit criteria

- [ ] Neurolink: load UI dismisses; WASD moves drone; no `disableAll pinned` spam at spawn during free-flight.
- [ ] SpaceRunner map load freeze still pins (no fall-through edge bounce regression).
- [ ] Flagtag / sit mode-only freeze still escapeable if that path remains.
- [ ] Grep debt: no required `isAvatarLocomotionFrozenByPe` in PlayerSystem (claims only).

### Files likely touched

- `PlayerSystem.ts`, `ReservedEntitiesSync.ts`, `CrdtProjection.ts`
- `World.ts`, worker inject LWW
- `docs/ARCHITECTURE.md`

---

## 8. Dependency graph

```text
A registry ──► B claims ──► D pose modes
                 │
                 └──► C continuous tick (can parallel B after A; prefer after B freeze claim exists)
```

- **A first** (safe).
- **B before D** (modes need claims).
- **C** can start after A; safest after B so free-flight claim drives tick rate.

---

## 9. Testing matrix (human; no agent commit until tested)

| Scenario | A | B | C | D |
|----------|---|---|---|---|
| Genesis empty road walk | ✓ | ✓ | ✓ | ✓ |
| Enable Neurolink / smart wearable PE | ✓ | ✓ | ✓ | ✓ |
| PE free-flight WASD + camera | | ✓ | ✓ | ✓ |
| PE loading message clears | | | ✓ | ✓ |
| Primary scene IM freeze (plaza welcome / menu) | | ✓ | | ✓ |
| SpaceRunner / map load freeze pin | | | | ✓ |
| Plaza bounce parasol impulse | | ✓ | | |
| PE UI open/close + primary walk | ✓ | ✓ | ✓ | ✓ |
| Two PE cap / disable PE | ✓ | ✓ | | |

**DevTools signals (D):**

- `[layers] …`
- `[player] scene-owned` / pose mode (or claim snapshot log once on change)
- `[sceneWorker] pe-input` / layer-tick with `freeFlight=1` and non-empty `pressed=` when holding W
- Absence of continuous `disableAll pinned` at spawn during free-flight

---

## 10. PR stacking suggestion (Graphite / plain git)

1. **`feat(layers): registry + primary registration`** (Phase A only)  
2. **`feat(layers): locomotion + camera claims`** (Phase B partial)  
3. **`feat(layers): force/impulse claims; retire PeMainThreadMirror`** (Phase B complete)  
4. **`fix(layers): unified continuous tick`** (Phase C)  
5. **`feat(layers): HostPoseMode; remove free-flight special cases`** (Phase D)

Each PR: playable client; no “half rewrite” branch.

---

## 11. Open decisions (resolve during B design pass if needed)

1. **Camera claim vs primary freecam:** PE bound MainCamera always beats unbound primary? (Recommended: yes.)  
2. **Pose follow:** on `layer_drive`, follow PlayerEntity feet every frame vs lens-only when VC bound? (Recommended: follow feet always for attach/parent correctness; VC still drives lens.)  
3. **Claim sampling:** after layer tick vs only on `player-frame` message? (Recommended: after tick + on player-frame for IM/MainCamera hot path.)  
4. **Secondary claims:** secondary never wins locomotion/camera? (Recommended: ignore secondary for those claims.)

---

## 12. Success definition

We are “back to layers” when:

1. Primary and PE are both **registry entries**.  
2. Freeze / camera / free-flight pose go through **claim merge**, not PE-named host APIs.  
3. Continuous ticks are **layer policy**, not a PE-only scheduler product.  
4. Temporary free-flight pin/skip hacks are **deleted** in favor of `HostPoseMode`.

Until then, keep short-term PE fixes on `lastraum` if needed for playability; do not expand them—route new work into A–D.

---

## 13. Implementation map (A–D on `lastraum`)

| Phase | Code |
|-------|------|
| **A** | `SceneLayerRegistry.ts` · `MultiSceneRuntime.layers` · PE/secondary register · `World.registerPrimary` |
| **B** | `PlayerClaimMerger.ts` · `World.applyLayerPlayerClaims` · camera/locomotion/pose/force claims |
| **C** | `sceneWorker.runLayerContinuousTick` / `layerNeedsContinuousTick` (replaces PE-only pump product) |
| **D** | `HostPoseMode.ts` · `setHostLayerDrivePoses` · poseDrive → `layer_drive` |

**DevTools signals:** `[layers] registry…` · `[layers] locomotion/camera/poseDrive claim…` · `[layers] HostPoseMode → …` · `[sceneWorker] layer-tick …`

---

## 14. Doc history

| Date | Note |
|------|------|
| 2026-07-22 | Initial plan on `lastraum` (design only) |
| 2026-07-22 | A–D implemented on working tree — human test before commit |
