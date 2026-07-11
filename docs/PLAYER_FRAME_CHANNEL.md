# Player frame channel (Option B)

> **Goal:** Explorer-parity input order for **all SDK7 scenes** (no scene code changes) with **lower latency** than hot-path CRDT acks.

**Branch:** `lastraum` · **Scene under test:** `rickroll.dcl.eth` (camera-operator bundle, no scene changes)

---

## Problem

Worker and main are split. Scenes write `InputModifier` / `MainCamera` on the worker; main avatar locomotion reads the **mirror** on `PlayerEntity`. CRDT acks on the hot path race cooperative ticks, react-ecs, and `PlayerSystem` — MOVE CAMERA and similar flows flip state before main applies the freeze.

## Target semantics (one logical frame)

```text
hardware input → worker engine.update (scene systems) → player-frame apply on main → PlayerSystem.tick → render
```

- **Hot path:** `InputModifier` (1078), `MainCamera` (1075) — synchronous worker→main message, **no ack**.
- **VC bind hydrate:** `vc-bind-hydrate` — Transform + VirtualCamera + ancestor chain when MainCamera bind **graph** changes (structural; before player-frame). Graph-hash change only; main may `request-vc-bind-hydrate` once if incomplete.
- **VC flight path:** `vc-pose-live` — live `VirtualCamera` `Transform` while MainCamera is unbound during MOVE CAMERA edit flight (no ack). Bound follow anchors also live when pure transform.
- **Cold path:** world CRDT (entities, tweens, triggers) — batched per unified play frame, play mode without ack where safe.
- **UI path:** structured mount snapshot on pointer phase-4 (unchanged, still acked).

Scenes keep calling `InputModifier.createOrReplace` / `MainCamera.createOrReplace` in the worker; the shim owns transport.

---

## Messages

### `player-frame` (hot path)

```typescript
type SceneWorkerPlayerFrame = {
  type: 'player-frame'
  frameId: number
  inputModifierHas: boolean
  inputModifier?: unknown
  mainCamera: unknown
}
```

- Posted from worker when snapshot **changes** (play mode only).
- Sources: `onAfterEngineTick`, end of unified play frame (`completePlayFrameColdEgress`), pointer flush (phase 4).
- Main applies in `SceneScriptSystem.worker.onmessage` **before** avatar locomotion for that rAF (best-effort — worker tick is async).
- Play-mode `rpcCrdt` **strips** 1075/1078 from outbound blobs (`stripPlayerFrameComponentsFromCrdt`).

### `vc-pose-live` (edit-flight path)

```typescript
type SceneWorkerVcPoseLive = {
  type: 'vc-pose-live'
  entity: number
  transform: { position; rotation; scale; parent? }
}
```

- Posted when MOVE CAMERA freezes locomotion **and** MainCamera has no `virtualCameraEntity` bind.
- Main `applyVcPoseLive` updates projection when `playerEditFlightLiveLane` is true (set from frozen IM + unbound VC in `applyPlayerFrame`).
- Gizmo is parented under VC `cameraEntity` in camera-operator scene — moving VC Transform should move gizmo if main applies Transform diff.

### `play-frame-tick` (main → worker, phase 2)

- Posted once per main rAF from `World.onSyncFrame` → `SceneScriptSystem.tickPlayFrame()`.
- Worker runs one **unified play frame** when `sceneEngineTickDue` (16 ms high tier after `scene-play-ready`).
- After play-ready, cooperative `setInterval` only drains queues; engine work is main-driven.

---

## Unified play frame (phases 2–3)

One logical worker frame in play mode:

```text
play-frame-tick (main rAF)
  → engine.update(dt)                    // cooperative tick — systems + deferred react-ecs
  → onAfterEngineTick                    // player-frame + vc-pose-live (change-only)
  → exports.onUpdate(dt) pollEvents only // SKIP_ENGINE_UPDATE_THIS_FRAME
  → flushPlayModeColdCrdtEgress          // coalesced fire-and-forget crdt-outbound (no id)
  → publishPlayerFrameIfChanged          // post-poll IM/MC snapshot
```

**SDK `onUpdate` patch** (`patchSdkOnUpdatePollEvents.ts`):

- `__THREEJS_SKIP_ENGINE_UPDATE_THIS_FRAME__` — skip duplicate `engine.update` in onUpdate.
- `__THREEJS_DEFER_SDK_POLL_EVENTS__` — skip pollEvents once after inject-only UI click.
- `__THREEJS_DEFER_SDK_POLL_EVENTS_LATCH__` — skip pollEvents while locomotion freeze latch active.

**Removed:** separate throttled `scheduleSceneUpdate` path (was second `engine.update` every 400–900 ms).

**Hydration** (`sceneOnUpdatePaused`): interval-driven engine ticks only; CRDT still uses ack + reconcile for 1075/1078.

---

## InputModifier policy (MOVE CAMERA) — revised 2026-07-08

**Scene-authoritative.** camera-operator re-applies freeze every frame while `editFlightActive` (`refreshPlayerInputLock`). The shim must **not** re-apply or block clear of InputModifier.

| Mechanism | Role |
|-----------|------|
| `player-frame` | Mirrors **live** worker IM + MainCamera to main (no ack) |
| `isWorkerLocomotionFreezeLatched()` | Reads last collected live freeze — drives flight pump / `vc-pose-live` / pollEvents defer only |
| ~~freeze latch re-apply~~ | **Removed** — blocked STOP permanently |
| ~~createOrReplace clear guard~~ | **Removed** — scene may clear anytime |

**Flight keys:** `scene-input-snapshot` with WASD applies immediately even during pointer input session (coalesce-only starved `isPressed`).

---

## Pointer frame (phase 4)

Unchanged pipeline; ordering hardening:

```text
inject PET_DOWN → engine.update(0)
→ (optional) exports.onUpdate on non-inject path
→ inject PET_UP → engine.update(0)
→ react-ecs fingerprint flush (inject-only)
→ phase-4 UI snapshot
→ engine.update(0) non-Ui phase
→ flushPointerDeferredOutboundsAsync:
     1. publishPlayerFrameIfChanged()   // hot path first
     2. flushPlayModeColdCrdtEgress() // any buffered cold CRDT
     3. non-Ui CRDT chunks (acked)
     4. atomic UI mount snapshot (acked)
→ pointer-deliver-done
```

Inject-only UI clicks skip mid-batch `exports.onUpdate`; defer pollEvents on next cooperative/unified frame.

---

## Phases

| Phase | Scope | Code | QA (rickroll MOVE CAMERA) |
|-------|--------|------|---------------------------|
| **1** | `player-frame` + strip 1075/1078 + main apply | ✅ Landed | ⚠️ Partial — locomotion blocks; flight/unlock broken |
| **2** | Single play frame per rAF; no double `engine.update` | ✅ Landed | ⚠️ No user-visible fix yet |
| **3** | Batched cold CRDT; no play-mode ack (non-pointer) | ✅ Landed | ⬜ |
| **4** | Pointer: player-frame before cold CRDT same batch | ✅ Landed | ⚠️ STOP still stuck |
| **5** | `UiStack` orchestrator (parcel + wearables) | Planned | — |

---

## File map

| File | Role |
|------|------|
| `src/shim/types.ts` | `player-frame`, `vc-pose-live`, `play-frame-tick` types |
| `src/shim/worker/workerPlayerFrameEgress.ts` | Snapshot, diff, latch, CRDT strip |
| `src/shim/worker/workerPlayFrameScheduler.ts` | Poll-only onUpdate leg, cold CRDT buffer/flush |
| `src/shim/worker/patchSdkOnUpdatePollEvents.ts` | Skip engine.update + defer pollEvents boundaries |
| `src/shim/worker/inputModifierLocomotionGuard.ts` | Block accidental IM clear; latch clear on allowed unfreeze |
| `src/shim/worker/sceneEngineScheduler.ts` | `onUnifiedPlayFrameComplete` after cooperative engine.update |
| `src/shim/worker/sceneEngineUiScheduler.ts` | react-ecs defer during latch / pointer session |
| `src/shim/worker/sceneWorker.ts` | Unified tick, rpcCrdt batching, vc-pose-live, pointer flush |
| `src/shim/worker/sceneWorkerInputSession.ts` | Pointer phases; inject-only locomotion clear allowance |
| `src/core/systems/SceneScriptSystem.ts` | `applyPlayerFrame`, `applyVcPoseLive`, `tickPlayFrame` |
| `src/core/World.ts` | Posts `play-frame-tick` before locomotion each rAF |

**Read-only scene reference:** `../camera-operator/scene/src/camera/VirtualCameraRig.ts` — MOVE CAMERA, `updateCreatorEditFlight`, `bodyEntity` parented to `cameraEntity`.

---

## Debug

| URL flag | What it shows |
|----------|----------------|
| `?sceneuidebug` | `InputModifier locomotion=blocked/allowed`, `player-frame #N editFlightLive=true/false` |
| `?sceneinputsnapshot` | Worker keyboard snapshot apply |
| `?pointerverbose` | Pointer deliver / engine tick logs |

Ignore MetaMask `contentscript.js` `MaxListenersExceededWarning` — unrelated.

**Expected on MOVE CAMERA click:** `player-frame #N im=true vc=cleared editFlightLive=true`  
**Expected on STOP:** `im=false` or cleared standard mode, `editFlightLive=false`, locomotion allowed.

---

## Known open issues (handoff)

1. **STOP / WASD** — latch + clear-block **removed**; flight keyboard apply-during-session **landed**. **Hard-refresh and retest.** Look for `pointer DOWN done — frozen=true/false`.
2. **play-frame-tick async race** — `player-frame` may arrive after `PlayerSystem.tick` same rAF.
3. **pollEvents deferred while frozen** — intentional while live freeze; re-evaluate if it causes side effects.
4. Full debt list: [ARCHITECTURE_AND_TECH_DEBT.md](./ARCHITECTURE_AND_TECH_DEBT.md).

---

## Non-goals

- Multi-worker wearables (`UiStack`) — Phase 5.
- Scene bundle changes (ThreejsClient shim only).
- Removing worker/main split.