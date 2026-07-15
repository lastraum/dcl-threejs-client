# Architecture overview & tech debt (2026-07-08)

> Living snapshot after RickRoll MOVE CAMERA QA failures.  
> Companion: [PLAYER_FRAME_CHANNEL.md](./PLAYER_FRAME_CHANNEL.md) · [PLAYER_FRAME_PROGRESS.md](./PLAYER_FRAME_PROGRESS.md) · [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) · [INTEGRATION.md](./INTEGRATION.md) · `.cursor/rules/worker-input-architecture.mdc`

---

## 1. What this client is

Browser-native DCL SDK7 client: load Worlds/parcels → run `bin/scene.js` in a **Web Worker** shim → mirror ECS to **Three.js** on main → HUD / chat / social shell.

```text
Main (rAF)                          Worker (scene.js)
──────────                          ────────────────
Three.js + PlayerSystem             @dcl/ecs engine + systems
SceneUiBridge (DOM UI)              react-ecs UI + VirtualCameraRig
PointerEventsSystem                 PointerEventsResult inject
SceneInputRelay (WASD)              inputSystem.isPressed
        │  postMessage lanes        │
        ├─ inject-pointer-click  ──►│ priority deliver queue
        ├─ scene-input-snapshot  ──►│ PETs on PlayerEntity
        ├─ pump-scene-engine-tick──►│ flight engine.update
        ├─ play-frame-tick       ──►│ unified play frame
        ◄── player-frame ───────────┤ InputModifier + MainCamera (no ack)
        ◄── vc-pose-live ───────────┤ VC Transform during edit flight
        ◄── crdt-outbound ──────────┤ cold world + UI mount snapshot
```

**Parity target:** Unity Foundation Explorer behavior for scene I/O, not identical internal architecture.

---

## 2. Document map (what is still true)

| Doc | Role | Freshness |
|-----|------|-----------|
| `IMPLEMENTATION_PLAN.md` | Original phased plan + architecture sketch | Stale on milestones; still good for “what the client is” |
| `PROGRESS.md` | Shipped milestones log | Good; player-frame marked in progress |
| `INTEGRATION.md` | ECS/UI/networking checklist | Partially stale (Ui* marked ⬜; scene UI is partial on lastraum) |
| `PLAYER_FRAME_CHANNEL.md` | Option B hot path design | Active |
| `PLAYER_FRAME_PROGRESS.md` | MOVE CAMERA QA handoff | Active |
| `SCENE_UI_POINTER_REMAINING.md` | Creator modal pick issues | Older; z-order pick landed |
| `worker-input-architecture.mdc` | Hard rules for pointer/UI CRDT | **Authoritative for input** — keep updated |

---

## 3. Current critical path: MOVE CAMERA (RickRoll)

### Expected Explorer-like flow

1. CREATOR → edit camera → **MOVE CAMERA** → scene freezes avatar IM, flies VC with WASD  
2. Scene systems read `inputSystem.isPressed` every `engine.update`  
3. **STOP** → clear IM, restore walk  

### What QA shows (unchanged until latch removal)

| Step | Result |
|------|--------|
| MOVE CAMERA | ✅ Avatar freezes (`editFlightLive=true`) |
| WASD | ❌ Gizmo/camera does not move |
| STOP | ❌ Avatar stays locked |

### Root causes (revised after failed latch-window fix)

1. **Shim freeze latch was wrong**  
   camera-operator already re-freezes every frame while `editFlightActive`.  
   Worker latch + blocked `createOrReplace` clear fought **STOP** and re-published frozen IM.  
   **Fix (2026-07-08):** remove re-apply latch and clear-blocking; scene owns IM; `player-frame` mirrors live state only.

2. **Keyboard coalesce during pointer session**  
   WASD snapshots only coalesced while pointer input session open; PETs never applied if mount resume lagged. Flight pump ran `engine.update` with empty `isPressed`.  
   **Fix:** apply flight-key snapshots immediately even during pointer session.

3. **Noise (ignore)**  
   MetaMask `contentscript.js` MaxListeners / ObjectMultiplex — browser extension, not client.

### Retest after this change

```
?sceneuidebug  (optional ?sceneinputsnapshot)
```

Expect on MOVE: `pointer DOWN done — … frozen=true`  
Expect on STOP: `pointer DOWN done — … frozen=false` then `editFlightLive=false`  
Expect WASD: gizmo moves; worker may log `scene-input-snapshot` with `?sceneinputsnapshot`

---

## 4. Architecture debt (priority)

### P0 — Scene I/O correctness (blocks creator tools / many scenes)

| Debt | Why it hurts | Direction |
|------|----------------|-----------|
| **Over-shimmed InputModifier** | Latch/guards violated scene authority | ✅ Removed re-apply latch; keep `player-frame` only |
| **Pointer session vs keyboard** | Coalesce starved flight PETs | ✅ Flight keys apply immediately |
| **pollEvents defer while frozen** | Can hide side effects; STOP uses inject not pollEvents | Keep for now; re-evaluate if UI stalls |
| **Async play-frame-tick vs rAF** | `player-frame` may land after `PlayerSystem.tick` same frame | Apply pending player-frame sync at start of locomotion tick |
| **Ui mount vs DOM hit-map drift** | `hit map ≠ DOM` warnings; bad picks | Single authority: mount snapshot + yoga layout parity |
| **Edit-flight InputModifier / VC shim leftover** | Latch/guards remain; 2026-07-11: flight pump works when MainCamera **bound** (MOVE lens preview) via `isWorkerMoveCameraFlightLatched` + bound VC target | Retest MOVE/WASD/STOP; then strip remaining invent-policy toward pure transport. See [PLAYER_FRAME_PROGRESS.md](./PLAYER_FRAME_PROGRESS.md). |

### P1 — Performance (Explorer-class browser budget)

| Debt | Notes |
|------|--------|
| **Mesh frame law (P0 mesh)** | See [MESH_RUNTIME.md](./MESH_RUNTIME.md) — bytes-only content-map warm; never await cold parse/clone on rAF; parse concurrency 1; large clones via idle. **No distance streaming.** |
| Worker CRDT ack round-trips on cold path | Phases 2–3 moved play-mode cold CRDT fire-and-forget; verify no stalls |
| Pointer flush still acks UI snapshot | Correct for UI atomicity; avoid extra non-Ui acks |
| Full UI mount touch on growth | Expensive on large menus; dirty-only is default |
| Third-person camera lerp + foliage | Documented jitter; not MOVE CAMERA |
| Asset texture 404s (`Floor_Sand01.png.png`) | Content/path bug; wasted loads |

### P2 — Product / parity gaps (from INTEGRATION + PROGRESS)

| Area | Status |
|------|--------|
| Scene UI (UiTransform stack) | Partial — works for many panels; Creator modal edge cases remain |
| UiStack multi-worker (wearables) | Planned Phase 5 |
| Social 2D shell | ✅ multi-room chat + Watch Lite cast on `dev-latest` (2026-07-14); remaining: voice, DMs, `/goto` |
| Open-world multi-scene | Later |
| GltfContainerLoadingState, NftShape, AvatarModifierArea | Not started |

### P3 — Process / docs debt

| Debt | Action |
|------|--------|
| Docs disagree (architecture rule vs flight pump comments) | Keep `worker-input-architecture.mdc` as SSOT; update when code changes |
| INTEGRATION.md Ui* ⬜ | Update when scene UI is declared partial/render |
| Dual branch (`lastraum` vs `dev-latest`) | Merged multi-room/cast slice 2026-07-14; keep `lastraum` for ongoing product work |
| Defensive dual paths (legacy pointer stash, dual CRDT) | Prefer one path; delete dead code when QA-green |

---

## 5. Design principles going forward

1. **Scene owns InputModifier / MainCamera writes** — shim transports, does not invent freeze policy.  
2. **Hot path without ack** — IM/MC/`vc-pose-live` never wait on main CRDT ack.  
3. **Pointer UI has one egress** — phase-4 structured mount snapshot only.  
4. **No belt-and-suspenders** — if a race exists, fix the phase boundary; do not re-apply opposing state.  
5. **Flight = engine systems + keyboard PETs** — not full SDK `onUpdate`/pollEvents.  
6. **Ignore extension console noise** when diagnosing.

---

## 6. Suggested next engineering order

1. **Finish mesh revamp** (frame law, instancing, mass attach) — [MESH_RUNTIME.md](./MESH_RUNTIME.md).  
2. **Then: edit-flight InputModifier / VC shim cleanup** (P0 table) — scene-authoritative IM/MC; no clear/freeze inventing in worker.  
3. Retest MOVE / WASD / STOP after that cleanup.  
4. Sync `player-frame` apply before `PlayerSystem.tick` (one-frame latency) if still needed.  
5. Update INTEGRATION.md scene UI status; plan `dev-latest` merge.  
6. Broader performance pass: rAF (main) + worker tick ms on Genesis + RickRoll.

---

## 7. Non-goals (this cycle)

- Changing camera-operator scene bundle  
- Rewriting Three.js renderer  
- Matching Unity internal scheduling exactly  
- Fixing MetaMask content-script warnings  
