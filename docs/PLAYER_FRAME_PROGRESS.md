# Player frame channel — progress

> Implementation: [PLAYER_FRAME_CHANNEL.md](./PLAYER_FRAME_CHANNEL.md)  
> Pointer/UI rules: `.cursor/rules/worker-input-architecture.mdc` (note: flight pump wording may be stale — see log below)

**Started:** 2026-07-08  
**Last updated:** 2026-07-11 (MOVE CAMERA edit-flight: flight when lens bound)  
**Branch:** `lastraum` / `dev-latest`  
**Architecture debt:** [ARCHITECTURE_AND_TECH_DEBT.md](./ARCHITECTURE_AND_TECH_DEBT.md)

---

## Summary for handoff

Phases **1–4** landed. **2026-07-11:** VirtualCamera bind production-ready. MOVE CAMERA residual: flight pump no longer requires MainCamera unbound (bound lens preview can fly that VC).

| Step | Expected | Status |
|------|----------|--------|
| MainCamera bind + Transform/VirtualCamera on main | Lens active | ✅ `vc-bind-hydrate` + live lane |
| Locked / cinematic VC | Worker world pose under Root | ✅ |
| `parent === lookAt` follow | f(player)+local every frame | ✅ no hitch flicker |
| Hydrate only on structure change | No per-frame spam | ✅ |
| WASD under active VC | Matches freecam basis | ✅ |
| MOVE CAMERA freeze + flight + STOP | Full edit-flight loop | 🟡 retest (flight when bound fixed) |

See [PLAYER_FRAME_CHANNEL.md](./PLAYER_FRAME_CHANNEL.md) for the transport model.

---

## Phase 1 — Hot player snapshot (no CRDT ack)

| Task | Status | Notes |
|------|--------|-------|
| Design doc | ✅ | `PLAYER_FRAME_CHANNEL.md` |
| `player-frame` type + worker collector | ✅ | `workerPlayerFrameEgress.ts` |
| Worker publish on `onAfterEngineTick` | ✅ | Play mode, change-only |
| Main `applyPlayerFrame` fast path | ✅ | `SceneScriptSystem` onmessage |
| Strip 1075/1078 from play-mode `rpcCrdt` | ✅ | Hydration still uses reconcile |
| Pointer flush uses strip in play mode | ✅ | `flushPointerDeferredOutboundsAsync` |
| `vc-pose-live` edit-flight lane | ✅ | `publishVcPoseLiveDuringEditFlight` + `applyVcPoseLive` |
| Locomotion freeze latch | ✅ | `locomotionFreezeLatch` + guards |
| Manual QA: MOVE CAMERA + WASD + STOP | ❌ | Blocks OK; flight + unlock broken |

### Phase 1 hardening (landed)

| Task | Status | File(s) |
|------|--------|---------|
| Freeze latch persist across cooperative ticks | ✅ | `workerPlayerFrameEgress.ts` |
| Block accidental IM clear | ✅ | `inputModifierLocomotionGuard.ts` |
| `deleteFrom` patch on InputModifier | ✅ | `inputModifierLocomotionGuard.ts` |
| `clearPlayerInputModifier` block hook | ✅ | `patchClearPlayerInputModifier.ts` |
| Defer pollEvents after inject-only UI click | ✅ | `patchSdkOnUpdatePollEvents.ts` |
| Defer pollEvents while latch active | ✅ | `patchSdkOnUpdatePollEvents.ts` |
| Re-apply freeze before patched `engine.update` | ✅ | `sceneEngineUiScheduler.ts` |
| Flight pump bypass `sceneTicksPaused` when latched | ✅ | `sceneWorker.ts` `flightPumpBypassPause` |
| `playerEditFlightLiveLane` on main | ✅ | `SceneScriptSystem.applyPlayerFrame` |

---

## Phase 2 — Single play frame per rAF

| Task | Status | Notes |
|------|--------|-------|
| Patch SDK onUpdate — skip duplicate `engine.update` | ✅ | `SKIP_ENGINE_UPDATE_THIS_FRAME` |
| Unified frame: engine.update → pollEvents only | ✅ | `onUnifiedPlayFrameComplete` |
| Remove `scheduleSceneUpdate` double tick | ✅ | Deleted from cooperative loop |
| Main `play-frame-tick` per rAF | ✅ | `World.ts` → `SceneScriptSystem.tickPlayFrame()` |
| Interval drain-only after play-ready | ✅ | `playFrameTickMainDriven` |
| Align tick to 16 ms high tier | ✅ | `applyPlayReadyTiming` + `sceneEngineTickDue` |
| Manual QA | ⚠️ | No improvement reported on MOVE CAMERA |

---

## Phase 3 — Cold CRDT batch (play mode)

| Task | Status | Notes |
|------|--------|-------|
| Buffer play-mode `rpcCrdt` non-pointer chunks | ✅ | `bufferPlayModeColdCrdt` |
| Coalesce + flush end of unified frame | ✅ | `flushPlayModeColdCrdtEgress` |
| Fire-and-forget outbound (no `id`) | ✅ | Main acks only when `id` present |
| Hydration still acked | ✅ | `sceneOnUpdatePaused` path unchanged |
| Pointer UI batches still acked | ✅ | `flushPointerDeferredOutboundsAsync` |
| Manual QA | ⬜ | Not isolated |

---

## Phase 4 — Pointer atomic egress

| Task | Status | Notes |
|------|--------|-------|
| `player-frame` before cold CRDT in pointer flush | ✅ | `flushPointerDeferredOutboundsAsync` |
| Flush buffered cold CRDT in pointer batch (play mode) | ✅ | Before acked non-Ui chunks |
| Inject → update → egress same logical batch | ✅ | Existing pipeline + ordering |
| Manual QA: CAM → CREATOR → MOVE CAMERA → STOP | ❌ | STOP unlock still fails |

---

## Phase 5 — UiStack

| Task | Status |
|------|--------|
| Parcel + wearables orchestrator | ⬜ Planned |
| z-order hit test | ⬜ Planned |

---

## Verification commands

```bash
npx tsc --noEmit          # must be clean
npm run test:locomotion   # 21/21 unit tests (mirror read path only — not MOVE CAMERA E2E)
```

Manual: load RickRoll with `?sceneuidebug`, CREATOR MODE → MOVE CAMERA → WASD → STOP MOVE CAMERA.

---

## Next investigation (priority order)

1. **Manual QA** — RickRoll `?sceneuidebug`: CREATOR → MOVE CAMERA → WASD (gizmo/lens moves) → STOP (walk restored). Prefer bound-lens and unbound paths.
2. **STOP / latch** — If unlock still fails: trace `forceUnfreeze` + `refuseFreezeWrites` vs scene re-freeze every tick.
3. **rAF ordering** — Apply pending `player-frame` at start of `PlayerSystem.tick` if one-frame lag remains.
4. **Strip shim policy** — Longer-term: scene-authoritative IM only; drop belt-and-suspenders once QA green.

**Do not change** camera-operator scene bundle — ThreejsClient shim only.

### 2026-07-11 (MOVE CAMERA flight when lens bound)

- Root cause of WASD no-op: `isEditFlightMode()` and shim flight required MainCamera **unbound**, but MOVE CAMERA often **binds** the VC for lens preview → flight pump never ran.
- Fix: edit flight = `pointer-move` freeze latch only; resolve flight target prefers bound `MainCamera.virtualCameraEntity`; main `playerEditFlightLiveLane` accepts frozen locomotion even when bound.

---

## Log

### 2026-07-08 (initial)

- Chose **Option B** (fast lane + batched CRDT) over CRDT-only phase guards.
- Phase 1 code landed: `player-frame`, worker egress, main apply, play-mode CRDT strip.

### 2026-07-08 (hardening)

- UI click ordering fixes (react-ecs defer, inject-only pollEvents defer, monotonic `frameId`).
- Locomotion latch + `inputModifierLocomotionGuard` + pollEvents latch hook.
- `vc-pose-live` edit-flight lane for unbound MainCamera during MOVE CAMERA.
- Flight pump allowed while latch even if `sceneUpdateInFlight`.

### 2026-07-08 (phases 2–4 — single pass)

- `workerPlayFrameScheduler.ts` — unified poll leg + cold CRDT buffer.
- `play-frame-tick` main rAF driver; removed duplicate `scheduleSceneUpdate`.
- Play-mode `rpcCrdt` batches cold CRDT without ack.
- Pointer flush: `player-frame` before cold egress.
- `tsc` clean; `test:locomotion` 21/21.

### 2026-07-08 (user QA — still open)

- User report after phases 2–4: locomotion **blocks** on MOVE CAMERA (good) but **gizmo does not move** and **STOP does not unlock** InputModifier.
- Console noise from MetaMask `contentscript.js` — ignore.
- Heartbeat logs show `sceneTickIntervalMs=16`, pointer UI snapshot completing — worker alive; issue is hot-path semantics not worker stall.

### 2026-07-08 (docs)

- Updated `PLAYER_FRAME_CHANNEL.md` and this file for model handoff.

### 2026-07-08 (user QA log re-read + latch fix)

**Confirmed from console:**

| Signal | Evidence |
|--------|----------|
| Freeze OK | `player-frame #6/#7 im=true … editFlightLive=true` after MOVE CAMERA (entity 66127) |
| STOP stuck | Second 66127 click still `editFlightLive=true`; no later `im=false` / `editFlightLive=false` frame |
| WASD reaches main | `[input] scene relay DOWN button=4/6/7` (IA_FORWARD/RIGHT/LEFT) while latched |
| Noise | MetaMask `contentscript.js`, social 530, texture 404 — ignore |

**Latch-window fix retested: no improvement.** Then **latch removal retested: freeze no longer sticks.**

Logs (2026-07-08 c):

| Frame | Signal |
|-------|--------|
| #6 after MOVE | `pointer DOWN done — frozen=true` · `editFlightLive=true` |
| #7 cooperative | `editFlightLive=false` (freeze cleared on first tick after pointer) |
| #8 second click | freeze again briefly |
| #9 cooperative | unfrozen again |

**Root cause:** Same-click **freeze-then-clear** (double-toggle / re-entrancy). Without latch, clear wins. With naive latch, STOP also blocked.

**Fix (shim only, 2026-07-08 c):**

1. **Latch freeze** for egress + re-apply on cooperative ticks.
2. **Block clear only if** (a) outside inject while latched, or (b) clear in same inject **after** a freeze write (double-toggle).
3. **Allow STOP clear** during inject when no freeze was written earlier in that inject.
4. Keep flight-key snapshots applying during pointer session.
5. Deep-clone `player-frame` IM payload.

**Retest:** hard-refresh `?sceneuidebug`.  
MOVE → `frozen=true latched=true` and **stays** frozen · WASD gizmo · STOP → `frozen=false` walk.  
Watch for `blocked locomotion clear` (double-toggle) vs clean STOP.

### 2026-07-08 d (QA: freeze sticks, no WASD, no STOP)

Logs: `#6 frozen=true latched=false freezeThisInject=false` then stays `editFlightLive=true`; STOP `#8 frozen=true latched=true freezeThisInject=false` — clear never lands; freeze writes not noted via guard (SDK path).

**Fix:**

1. `reconcileLocomotionLatchAfterInjectDown` after every UI DOWN — capture MOVE latch from live IM; **force unfreeze** when click while already latched and no freeze write this inject (STOP).
2. After `createOrReplace`, re-read **live** IM to note freeze/clear (args may not match stored shape).
3. Flight pump always schedules while latched even if key set unchanged; log `flight pump — latched=true pressed=[…]`.

### 2026-07-08 e (QA: STOP unfreezes then re-freezes; flight pump has keys but no move)

Logs proved:

- MOVE latch works (`MOVE freeze captured`)
- Flight pump runs with `pressed=[4,6,7]` — keys reach worker
- STOP force unfreeze works (`#8 editFlightLive=false`) then **same pointer tick UP / next tick re-freezes** (`#9 editFlightLive=true`) — scene `editFlightActive` still true
- Scene `updateCreatorEditFlight` likely idle (`editFlightActive` false after double-toggle) so VC never moves despite keys

**Fix:**

1. **Sticky refuse freeze** after STOP — block createOrReplace freeze until next fresh MOVE inject
2. **Reassert PETs** every flight pump from `workerSnapshotPressed`
3. **Shim VC flight fallback** — if latched + keys but VC pose unchanged after `engine.update`, move VirtualCamera Transforms in the worker and publish `vc-pose-live`