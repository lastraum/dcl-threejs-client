# SceneLoop completion — host invert clock law

| Field | Value |
| --- | --- |
| **Status** | P0–P4 **in-tree with named leftovers**. Not a second engine. Not “landed.” |
| **Branch** | `feat/hot-reload` (target shape merged `perfv2` → `dev-latest`) |
| **Proof plan** | [V2.2_BEVY_PARITY.md](./V2.2_BEVY_PARITY.md) |
| **Law** | [ARCHITECTURE.md](./ARCHITECTURE.md) — host store is the world; worker is a guest VM |
| **Does not replace** | [WORKER_SYSTEM_PIE_V2.md](./WORKER_SYSTEM_PIE_V2.md) (parked), [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md), [FRAME_PIPELINE_COD.md](./FRAME_PIPELINE_COD.md) |

This is the missing half of invert. v2.0 shipped **who owns truth**. The **target shape** for **one guest clock** is already in this tree. Official Explorer desktop does the same split: native host writes reserved/input components, scene JS consumes them on the next **real-dt** tick. We already named that clock `SceneLoop`. Leftover extra-clock APIs and the pointer + Tween + timer walk-log are **not sealed**. Do not flip SceneLoop 🟢 without that walk-log **and** the dual-clock landmine sealed.

**Named scenes are guides, not law.** Genesis Plaza, Genesis CBD, SpaceRunner, Flagtag, NeonScreen, CREATOR Hub are example official bundles that happen to exercise the platform. Implementation is universal: no `if Genesis Plaza`, no CBD-only FPS path, no fishing-only pointer. If a law only makes sense on one of those names, it is the wrong law. Scene bundle is law.

Do not add a second scheduler. Do not resurrect a main-thread `@dcl/ecs` Engine. Do not name this after another client. Do not invent `getClick` / y=0 PE hits.

---

## Law (one page)

```text
PRESENT (host rAF, never blocked by JS)
  CCT + fold queued motion + extract + WebGL
  soft-route (URL / pill / minimap) + current-scene Focus
    ← which parcel your feet are on; stay on present

GUEST (SceneLoop, after present, one in-flight)
  apply reserved writers (PE / Camera / PPI / EngineInfo)
  host queries that scenes read this tick (Raycast, TriggerArea)
  write results into the guest store (no dirty echo)
  engine.update(real dt) once
  one scene-owned CRDT outbound
  ack play-frame-done
```

| Rule | Meaning |
| --- | --- |
| **One clock** | After the first play-frame, only named sources `play-frame` \| `pointer-edge` start `engine.update` with `dt > 0`. `SceneLoop.send` is the cadence clock. `pointer-edge` is inject-wakeup (skip-if-in-flight, never a stack). |
| **One in-flight** | If a guest tick is running, the next play-frame applies reserved poses and **acks**. It does not start a second update. **Never abort a live `engine.update`** (Bevy: skip-if-in-flight). |
| **Host writes, guest reads** | RaycastResult, TriggerAreaResult, PPI, PE/Camera Transform land in the guest store **before** that tick’s systems. |
| **No extra update from host LWW** | Applying RaycastResult / PPI / EngineInfo is not a reason to call `eng.update(0)`. Transport `dt === 0` must not stamp wall clocks or run react-ecs as a second clock. |
| **Pointer edges are inject-only** | PET_DOWN/UP write Input + PointerEventsResult, then **one** SceneLoop tick (or the in-flight tick) sees them. `isPressed` arms on DOWN, falls on UP. Both edges land on the **authored hit entity**. |
| **Skip if busy** | If last guest job is still in flight past the deadline, skip that guest this frame. Do not abort the live `engine.update`. |
| **Present is sacred** | Guest send/receive/apply never starts on the present rAF. Soft-route and Focus stay on present so URL / minimap / clicks do not lag a frame behind your feet. |

---

## What invert already shipped

| Piece | State |
| --- | --- |
| Host store (`CrdtProjection` + `EntityStore` + `PhysXWorld`) | Law |
| Worker = official `scene.js` VM | Law |
| SceneLoop guests (primary / PE / secondary) | Target shape in-tree — leftover extra-clock APIs remain |
| Play-frame reserved poses (PE, Camera, PPI) | In-tree — prove on a walk-log |
| Inject-only pointer | In-tree — leftover live-tick preempt; no-target 700 ms race remains |
| Pose vs draw (`poseRoot` / `drawRoot`) | Law |
| One outbound blob, no host echo | Law |
| Kernel TweenSequence (`ENABLE_SDK_TWEEN_SEQUENCE = false`) | Law |
| Raycast + TriggerArea once per guest tick | In-tree |
| Hover prepare edges + ~80 ms | Law |
| WSP systems pie | **Parked** — encode/send was the bill, not systems |

Do **not** re-implement P0–P4. Prove the invert and seal the leftovers ([V2.2_BEVY_PARITY.md](./V2.2_BEVY_PARITY.md)).

---

## Leftovers (named — not sealed)

The old “still not the law” table described the **pre-P0** tree (Raycast every rAF, `runSceneEngineUpdateNow(0)` on every host inject, play-frame-done held 2 s, pointer 1500 ms drop). Those specific symptoms are mitigated here. What remains:

| Leftover | Why it still matters | Seal |
| --- | --- | --- |
| `preemptSceneEngineTick` on pointer deliver | Epoch-kills a live `engine.update`. **No Bevy analog.** | **Sealed (PR-2):** skip when `sceneLoopOwnsPositiveDt` / `engineUpdateInFlight` |
| Unscoped `requestSceneEngineTick()` | Timed host inject could start without `source`. | **Sealed (PR-2):** `source` required; unscoped path is `queueSceneEngineTick` |
| `nudgePlayAfterSceneTeleport` → `tickPlayFrame()` | Extra play-frame **outside** `SceneLoop.send`. | **Sealed (PR-2):** resume + immediate; SceneLoop.send starts |
| `peTickIntervalMs() === 0` | PE pump every async frame **if** the ownership flag drops. | **Sealed (PR-2):** returns **50**, never 0 |
| `tickSync` can still `tickPlayFrame` | Dual-clock landmine if `!skipPlayFrame && !playFrameOwnedExternally`. | **Sealed (PR-2):** `skipPlayFrame: true` hard-coded |

Also unproven until a pasted walk-log (PR-3): pointer PET_UP on an authored hit, Tween duration ≈ wall, scene timers on real guest `dt`, no `dt=0.000` after the first `source=play-frame` line.

### PR-3 observability (instrumentation in — walk-log open)

- [x] `?sceneloop=1` (or existing worker verbose flag) play-frame line: `source` `dt` `inFlight` (HUD keeps live `g=`/`sent=`)
- [x] Fail window is readable: `source` is logged; hydrate ticks before the first `source=play-frame` are not a fail; `dt=0.000` after that line is a fail
- [x] Transport `dt === 0` does not stamp wall clock (`wrapEngineUpdateWithWallClock`)
- [x] MainFrameHud SceneLoop line: last guest `dt` + `src=` next to `g=/due=/sent=/inflight=`
- [ ] Pasted walk-log of pointer + Tween + scene timers on an official bundle — **SceneLoop stays 🟡**

---

## Target shape (full invert clock)

### 1. Present vs guest (already named)

```text
PRESENT (host rAF — never blocked by scene JS)
  fold queued guest motion
  CCT + host motion + input + AvatarAttach
  hover visuals if ≥ 80 ms or edge
  soft-route (URL / pill / minimap) + current-scene Focus   ← stay here
  AOI visuals (far shells)                                  ← PR-4 may measure moving this
  WebGL extract + beauty
  return                    ← guest send/receive/apply MUST NOT start here

AFTER rAF (SceneHost setTimeout(0) → onAsyncFrame)
  SceneLoop.receive         ← fold queued crdt-outbound
  tickSync                  ← reserved pose rebase ONLY (never tickPlayFrame)
  SceneLoop.send            ← due guests, skip if inFlight
      per guest:
        host query prepare (Raycast, TriggerArea, hover inject)
        reserved writers (PE / Camera / PPI / EngineInfo / attach / tween TF)
        play-frame-tick
        worker: apply reserved → engine.update(real dt) once → one outbound
        play-frame-done (or immediate ack if already in flight)
  apply current guest + leftover other live guests
```

Cadence: **20 Hz** (50 ms) via `SceneLoop.send`. Pointer **edge** may wake the next due tick immediately (`source: 'pointer-edge'`, skip-if-in-flight). It may not stack a second `engine.update`. If a tick overruns: **skip next guest**, do not kill the current one. `movePlayerTo` / PE `movePlayer` may mark the FocusOwner guest immediate and resume worker ticks — they must **not** call `tickPlayFrame()` themselves.

### 2. One guest tick

`requestSceneEngineTick` / `executeTickWork` / `runSceneEngineUpdateNow` collapse to:

1. If in flight → queue, do not start.
2. `dt = clamp(wall since last **positive** tick start, 1/120 … 0.25s)`.
3. One `engine.update(dt)`.
4. One outbound.
5. `play-frame-done`.

Quarantine as transport-only (no systems, no react-ecs, **no wall-clock stamp** on `dt === 0`):

- `runSceneEngineUpdateNow(0)` after RaycastResult / video offset / audio heartbeat
- Cooperative interval that races the play-frame
- Epoch-kill of a live native update (`preemptSceneEngineTick`)

### 3. Host queries once per guest tick

`RaycastSystem.sync` and TriggerArea overlap run on **SceneLoop prepare** (same cadence as play-frame, before the guest `engine.update`). Not every rAF.

| Query | When | Write |
| --- | --- | --- |
| Continuous `Raycast` | Once per guest tick | `RaycastResult` LWW, no dirty |
| One-shot `Raycast` | First tick after request | same |
| TriggerArea | Once per guest tick | grow-only enter/leave |
| Pointer **hover** prepare | Down / up / ~80 ms hover | PPI + hover target |
| Pointer **edge** | Browser down/up | inject PET + results |

Continuous camera-aim: PPI is already on the play-frame. Host recasts **that** ray on the same prepare. Guest raycast callback runs in the **same** `engine.update(dt)`. *Guide:* plaza fishing `z6e`.

### 4. Pointer

Platform law. Named scenes only illustrate it.

- `isPressed` arms on DOWN, falls on UP.
- `getInputCommand(IA_POINTER, PET_UP, entity)` is a real scene API. Host delivers both edges on the **authored hit entity** with live `hit.position`. Do not invent `getClick` or y=0 PE hits. *Guide:* plaza Cast Line on water mesh `gu`.
- Camera-drag discard is **scene** law (`getCameraWasDragged`), not a host filter.
- If a guest tick is in flight: write PET into the guest store immediately (or as soon as the mutex is free). **Do not** ack-done before the inject landed. **Do not** epoch-kill the live update (Bevy: skip-if-in-flight; no abort). Wakeup is `source: 'pointer-edge'` on the FocusOwner guest, skip-if-in-flight.

### 5. Tweens / Animator / emotes

| System | Clock |
| --- | --- |
| SDK `Tween` | Guest `dt` only |
| Scene timers (`idleEmoteTimer -= dt`) | Guest `dt` only |
| Host `AnimatorBridge` / avatar mixers | Present rAF |
| `triggerSceneEmote` | Host playback; scene decides when |

Scene-authored follow-up (emote after N seconds of real `dt`, next Tween hop) is **scene** law. Host does not invent the transition. *Guide:* plaza `triggerSceneEmote(Fishing_Idle)` after 1.3 s.

### 6. Physics

Unchanged invert law: one PhysX world on the host. CCT on present. Collider cook leftover, not on rAF. Guest never owns hulls. `PhysicsCombinedImpulse` is host-read on PlayerEntity.

### 7. CRDT I/O

One inbound inject per play-frame (reserved + query results). One outbound (scene-owned dirty + UI snapshot). WSP 0.5 already proved **postDump / dirty churn** is the send bill — keep that hygiene; do not unpark systems pie unless systems ms returns.

### 8. Scene UI

Yoga / DOM stay on host. Ui* still structured snapshot, never cooperative CRDT. Guest react-ecs runs **inside** the one `engine.update(dt)`, not a side loop that steals the mutex.

### 9. Multi-scene guests

Same SceneLoop queue. Primary first. At most **one** secondary tick per async frame — current/FocusOwner guest (feet on that parcel) wins the cap. Immediate wakeup is for `kind === 'primary'` **or** current/FocusOwner secondary. Mute **non-focus** secondaries at 50 ms. Shells are not guests. Never `secondaryTickIntervalMs = 0` + `tickPlayFrame` every async frame. Never `peTickIntervalMs = 0`.

### 10. Audio / video / asset-load

Host writes VideoEvent / AudioEvent / GltfContainerLoadingState into the guest store. **Next SceneLoop tick** sees them. No `eng.update(0)` per heartbeat.

---

## P0–P4 vs this tree

Do not treat the phases as a re-implement plan. Verdicts are against this tree.

### P0 — Stop extra clocks — **in-tree with named leftovers**

- Continuous RaycastResult does not force `eng.update(0)`
- Deferred play-frame acks so PPI keeps streaming
- Video-offset / audio / trigger heartbeats are store-only + next SceneLoop tick
- World PE / scene UI never budget-ack before PET lands
- Continuous rays recast on `tickPlayFrame`, not present rAF

**Named leftover:** `preemptSceneEngineTick` still runs on pointer deliver. That is a live-tick abort. Bevy never does this.

### P1 — SceneLoop is the only positive-dt starter — **in-tree with named leftovers**

- After first `play-frame-tick`, inbound / cooperative / hydration / keyboard only queue
- Named sources `play-frame` \| `pointer-edge` are the intended starts
- PE vehicle / flight pumps deleted as clocks (shim flight runs on the play-frame tick)
- Skip-if-in-flight is the law; leftover preempt still violates it

**Named leftovers:** unscoped `requestSceneEngineTick()` after timed host inject; `nudgePlayAfterSceneTeleport` still calls `tickPlayFrame()` outside `SceneLoop.send`.

### P2 — Host query prepare — **in-tree**

- `RaycastSystem` + TriggerArea run once per guest tick in `tickPlayFrame`
- Hover visuals on present at ~80 ms; hover PET injects on the guest tick
- Edges stay browser down/up

### P3 — Multi-guest + present isolation — **in-tree with landmines**

- SceneLoop.send: primary + PE due; at most one secondary per async frame
- `secondaryTickIntervalMs() === 50` (not 0)
- Secondaries / PE `setPlayFrameOwnedExternally(true)` at attach — happy path skips `tickPlayFrame` in `tickSync`
- Present rAF does not send/receive/apply or run TriggerArea
- Soft-route (URL/minimap) and Focus (which parcel your feet are on) stay on present
- Live guests stay default-on; shells / stand-on origin rebase stay default-off (separate residency chapter)

**Landmines (sealed in PR-2):** `tickSync` never calls `tickPlayFrame`; `peTickIntervalMs() === 50`. SceneLoop 🟢 still needs the pasted walk-log.

### P4 — Encode / apply leftovers — **in-tree**

- Empty `sendBinary` no longer awaits main (≤20 Hz poll)
- AvatarAttach + PE-follow Transform + Video/Audio/AudioAnalysis use `writeHostLwwNoDirty`
- WSP meters kept; systems pie still parked

---

## Explicit non-goals

- Main-thread `@dcl/ecs` Engine
- Scene-name forks (`if Genesis Plaza`)
- Systems pie on the default path
- Killing mid-`engine.update` / inventing Bevy `Broken`-on-timeout in 2.2
- Inventing `getClick` / y=0 PE hits
- Calling this another engine’s name
- Full open-world residency (shells, stand-on origin rebase)
- Flipping SceneLoop 🟢 without a pasted walk-log **and** the dual-clock seal

---

## File map

| Concern | This tree | 2.2 owner |
| --- | --- | --- |
| Guest clock | `sceneEngineScheduler.ts` + `sceneWorker.ts` play-frame; leftover unscoped + preempt | SceneLoop.send + named `pointer-edge` only |
| Reserved writers | `applyPlayFrameReservedPoses` | Unchanged, once per tick |
| Raycast | `RaycastSystem.sync` from `tickPlayFrame` only | Unchanged |
| Pointer inject | `inject-pointer-click`; leftover `preemptSceneEngineTick` | Inject + skip-if-in-flight; no abort |
| Teleport nudge | `nudgePlayAfterSceneTeleport` still `tickPlayFrame()` | Resume + immediate; SceneLoop.send starts |
| Dual clock | **Sealed (PR-2):** `skipPlayFrame: true`; `peTickIntervalMs === 50` | Unchanged |
| Present | `SceneHost` rAF | Unchanged |
| Guests | `SceneLoop.ts` | Unchanged API; current guest wins ≤1-secondary cap |

---

## Agent checklist before a SceneLoop PR

- [ ] Does not start `engine.update` except SceneLoop / named `pointer-edge` (or a named transport-only path with `dt === 0` and **no** systems/react)
- [ ] Does not epoch-kill a live `engine.update` (Bevy: skip-if-in-flight)
- [ ] Continuous ray recast ≤ once per guest tick
- [ ] Pointer DOWN/UP both land on the authored entity before ack
- [ ] Walk-log of pointer + Tween + scene timers pasted before SceneLoop 🟢 (*guide:* Genesis Plaza fishing — any official bundle that covers the same APIs is valid)
- [x] Dual-clock landmine sealed (`tickSync` never `tickPlayFrame`; `peTickIntervalMs === 50`) before SceneLoop 🟢
- [x] Play-frame `source`/`dt`/`inFlight` log + HUD last guest dt (instrumentation only — not a green)
- [ ] No scene-name branch
- [ ] Present rAF does not wait on the guest
