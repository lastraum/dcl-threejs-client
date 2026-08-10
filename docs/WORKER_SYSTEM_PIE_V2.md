# Worker System Pie v2 — design only (not implemented)

**Status:** Phase 0 / 0b / **0.5** instrumentation on branch `feat-wsp` (meters only). Phase 1+ not implemented.  
**Supersedes:** WSP v1 (`da7110f`…`cdf8de5`) — **reverted** on `dev-latest` after Genesis load/FPS regressions.  
**Baseline:** post-revert tip ≈ `fe4f24a` + terrain/platform (same architecture as pre-stall stack).

## Why v1 failed (constraints for v2)

1. **Wrong cost center.** Genesis FPS is dominated by main-thread GLTF attach, materials, PhysX cook/multi-shape, and SQ — not only worker systems. Budgeting systems alone cannot fix 3 FPS cook storms.
2. **Incomplete `engine.update` ownership.** Real cost = receive + systems + send + react-ecs. v1 budgeted systems (sometimes), left react outside, and logged pass-through as success (`pieHook=1 ran=0`).
3. **Cannot preempt mid-fn.** A 14 ms wall cannot abort a multi-second system on first run; quarantine only helps later ticks.
4. **Coupled to force-ready.** v1 shipped next to early enter-play / soft-hydrate amp — load pipeline failures were blamed on pie.
5. **Second scheduler vs COD.** Host already has cooperative ticks, pointer-edge budgets, and main COD. A second hard law without phase metrics fights recovery thrash.

## Goals

- Improve **steady-state FPS** on heavy (Genesis) and light scenes without breaking:
  - Scene-bundle-is-law / inject-pointer / level-state edges  
  - Grow-only CRDT + PE pose  
  - Main COD pipeline (materials, multi-scene, attach)  
  - Collider seal / play cook (boot vs play)  
- **Never** couple systems pie to hydrate force-ready or PhysX budgets.
- **Default off** until Genesis load ≈ pre-stall baseline and FPS measurably improves.

## Non-goals

- Shorten loading by attaching less or force-ready early.  
- Cap PhysX from the worker pie.  
- Skip react-ecs every time systems exceed 14 ms (v1 starvation mode).  
- Needle-patch only without honest attribution.

## Architecture fit (layers)

```
┌─────────────────────────────────────────────────────────────┐
│ Main rAF — COD (attach, materials, multi, play cook near)   │  ← highest leverage
├─────────────────────────────────────────────────────────────┤
│ Worker cooperative tick — eng mutex, pointer-edge budgets     │  ← already exist
├─────────────────────────────────────────────────────────────┤
│ engine.update phases (NEW meters)                             │
│   t_recv | t_systems | t_send | t_react | t_other             │
├─────────────────────────────────────────────────────────────┤
│ WSP v2 — systems only (HOT first, COLD residual + resume)     │  ← this doc
└─────────────────────────────────────────────────────────────┘
```

Ship order: **phase meters → optional systems pie (flag) → never load force-ready.**

## Phase 0 — Instrumentation only (ship first)

On every `engine.update` (or every Nth under load):

| Meter | Source |
|-------|--------|
| `t_recv` | CRDT / inbound before systems |
| `t_systems` | systems loop total |
| `t_hot` / `t_cold` | optional split after pie lands |
| `t_send` | outbound CRDT after systems |
| `t_react` | `@dcl/react-ecs` + ui-scale (after systems, Explorer order) |
| `t_total` | wall `engine.update` |
| `top[]` | EMA of system name → ms (cap 8) |

Log when `t_total ≥ 80` with **all** phases (not only systems).  
**Exit criterion:** one Genesis capture with clear share of recv/systems/send/react. No behavior change.

### Phase 0 / 0b implementation (`feat-wsp`)

| Piece | Role |
|-------|------|
| `src/shim/worker/workerEngUpdatePhases.ts` | begin/end, EMA top systems, CRDT meters, `[wsp0]` log |
| `sceneEngineScheduler` wrap | wall `total` around every `engine.update` |
| `installEngineSystemLoopPartition` | times scene systems vs react-ecs* |
| `rpcCrdt` (`sceneWorker`) | times each `crdtSendToRenderer` (ack vs immediate) |

@dcl/ecs `engine.update` is literally:

```text
await receiveMessages() → systems loop → await sendMessages()
```

Log line example:

```text
[wsp0] eng.update 96ms pre=0 systems=1 react=1 send=94 crdt=2ms×12(ack=0/0ms b=4800) n=67/67 loop=1 …
```

| Field | Meaning |
|-------|---------|
| **pre** | `receiveMessages` (before systems) |
| **systems** | scene systems only |
| **react** | react-ecs + ui-scale |
| **send** | `sendMessages` wall after systems |
| **crdt** | sum of nested `rpcCrdt` walls; ack= waited on main |
| **loop=0** | systems-loop patch miss |

Genesis Phase 0 capture: **systems≈1ms, send≈post≈80–500ms** → systems pie is not the bottleneck; next work is send/CRDT/main apply, not HOT/COLD.

Optional OK lines when `globalThis.__THREEJS_SCENEWORKER_PERF__ = true`.

## Phase 0.5 — Send dig (instrumentation only)

**Why:** Phase 0 showed `send ≫ systems` and `crdt ack=0` in play mode. Play-mode `rpcCrdt` is mostly fire-and-forget (`cold` / `hot-phys` / empty coalescing) — so a large `send` wall with `crdt≈0` means **SDK `sendMessages` encode** (dirty component iteration + buffer build), not waiting on main.

### Worker split (`[wsp0]` log when total ≥ 80ms)

| Field | Meaning |
|-------|---------|
| `send` | Full `sendMessages` wall |
| `enc` | systemsLoopEnd → first `rpcCrdt` entry ≈ **encode** |
| `xport` | Sum of `rpcCrdt` walls (post / strip / buffer) |
| `tail` | After last `rpcCrdt` until update resolves |
| `path=` | Outcome histogram: `cold`, `hot-phys`, `ack`, `empty-*`, `strip-*`, `boot`, … |

Example:

```text
[wsp0] eng.update 113ms pre=0 systems=0 react=1 send=112(enc=111 xport=0 tail=1) crdt=0ms×1(ack=0/0ms b=641) path=cold:1 …
```

**Read:** encode≈send → dig dirty CRDT volume / per-component `getCrdtUpdates`; not systems pie.

### Main apply (`[wsp05]` when apply ≥ 16ms)

```text
[wsp05] main crdt-apply 42ms n=1 b=641 ui=0 snap=0 ack=0 inbound=2
```

Independent of worker `enc` — correlates worker→main apply + projection fold. Throttled 1.5s.

### Exit criterion

- One Genesis + one light scene capture with `enc` / `xport` / `path` filled.  
- Decision: reduce dirty churn (encode) vs main apply vs both.  
- **Do not** start Phase 1 HOT/COLD until encode is small or proven unfixable.

### Genesis capture (2026-08-09, ~22 FPS, logs on)

| Signal | Value |
|--------|--------|
| systems / react | **1–5ms** |
| send / enc | **80–1220ms** (enc ≈ send) |
| xport / ack | **0** (play fire-and-forget) |
| path | almost always **`hot-phys:1`** (Physics / Material / MeshRenderer / Tween in payload) |
| main `[wsp05]` | **16–86ms** apply (secondary; real) |
| pointer | edge budget 700ms exceeded while eng.update stuck in encode |
| phys | post-seal SQ heal spam `didHit=false` map=1070 (COD, not WSP) |

**Conclusion:** Phase 0.5 exit met. Do **not** start systems pie. Next: attribute encode to component (`encTop=`) then cut dirty churn / serialize waste.

### Phase 0.5b — per-component encode meters

Wrap `component.getCrdtUpdates` after engine bind. Slow `[wsp0]` lines add:

```text
encTop=Transform:0ms×15 Tween:0ms×25 MeshRenderer:0ms×4
```

(`ms` = **produce-only** serialize time; `×N` = yielded PUT/DELETE messages.)

Genesis 0.5b result: dirty yields present but **produce ~0ms** — encode cost is not LWW serialize.

Also fixed: transfer-before-note made `b=0` on hot-phys; length is captured pre-`postMessage`.

### Phase 0.5c — encode sub-split (dump vs postDump)

Dump window = first→last `getCrdtUpdates` after systems (includes SDK write/onChange between yields).  
`encTop` `Name+sdk` = consumer time between yields when ≥0.5ms.

```text
send=90(enc=90 preDump=0 dump=12 postDump=78 xport=0 …) dump=180c/40m getCrdt=1ms encTop=…
```

| Field | Meaning |
|-------|---------|
| **preDump** | systems end → first getCrdtUpdates |
| **dump** | first→last getCrdtUpdates (serialize + SDK consumer) |
| **postDump** | last getCrdt → first rpcCrdt (transport buffer assembly) |
| **dump=Nc/Mm** | N getCrdt calls (components visited), M dirty messages |
| **getCrdt** | sum of produce-only serialize time |

**Genesis 0.5c re-capture (fixed timer):**

```text
enc=265 dump=1 postDump=264  dump=148c/35m getCrdt=1ms
enc=1454 dump=1 postDump=1453 …
enc=10631 dump=1 postDump=10630 …   // spike class
```

**Conclusion:** dirty dump is **~1ms**. Entire encode bill is **postDump** = SDK work after getCrdt until `transport.send` (transport pack over `crdtMessages`, including broadcast merge + network/renderer filters).

**Also saw:** multi-second eng.update + LiveKit disconnect + `RES_CRDT_STATE` — spike class.

### Phase 0.5d — postDump dig + cheap pack fix

1. **Meters:** `xfilt=Nms×calls` (transport.filter) + `xsend=r:bytes|n:bytes` on slow lines.  
2. **Patch:** scene-bundle `.toBinary().byteLength` → `.currentWriteOffset()` (O(1) size; payload `.toBinary()` unchanged).  
3. Transport wrap via addTransport capture hook.

**Genesis 0.5d capture:**

```text
postDump=403 xfilt=0ms×168 xsend=n:0|r:1821
postDump=1399 xfilt=0ms×120 xsend=n:0|r:1578
```

Filter free; network send **0 bytes** but **first** transport; renderer ~2KB.

### Phase 0.5e — root cause + fix (network sendBinary await)

SDK `@dcl/sdk/network/message-bus-sync` network transport (registered before renderer):

```js
send: async (messages) => {
  const response = await sendBinary({ data: [], peerData: peerMessages })
  binaryMessageBus.__processMessages(response.data)
}
```

`sendMessages` awaits each transport. Network-first → every eng.update **blocked on worker→main sendBinary RPC** (even empty `n:0`). That wait **was** postDump (100–400ms steady, multi-second spikes).

**Fix (0.5e):** `rpcSendBinary` posts outbound fire-and-forget and **immediately** resolves with inbound already buffered from the previous response (one-frame lag). eng.update no longer blocks on LiveKit publish RTT.

**Regression (0.5e alone):** Worker free → ~60 eng.update/s → **60× `comms-send-binary` posts/s to main** → main thrash → **11–17 FPS**. Logs: no `[wsp0]` (worker OK), `engineTickInFlight=false`, main crdt-apply + UI still busy.

**Fix (0.5f):** One in-flight main hop; queue real outbound; empty/inbound poll ≤20Hz. Still pure async → ~5 FPS + sync weirdness.

**0.5e–g worker-side sendBinary experiments REVERTED** (flooded main).  

**0.5h main-side empty fast-path:** `handleSendBinary` with no outbound only
`drainSceneBinaryInbound()` — no LiveKit publish hop. Worker still awaits the RPC, but
main work is O(queue). Real outbound still `await sendBinary(chunks)`.

### Phase 0.6 — Main hitch lines (always-on, sparse)

`[hitch] kind Nms detail` when a main load/compose wall ≥50ms:

| kind | Source |
|------|--------|
| `remote-vrm` / `remote-odk` | Custom peer mesh parse+mount |
| `remote-dcl` | Wearable compose for remote |
| `remote-pet` / `local-pet` | DPET pet GLB parse+mount |

### Follow-ups (ordered)

1. Capture logs-off steady FPS + any `[hitch]` on spikes to ~10  
2. **Main COD** if hitches name the spike: remote load budget, fishing UI enter/exit thrash  
3. **postDump** later: empty sendBinary without main flood  
4. **Phase 1** systems pie only if systems dominate

## Phase 1 — Systems pie (flag `?wsp=1` or settings)

### HOT (prefer this tick)

- SDK event drains: TriggerAreaResult, EventSystem, buttonState, sleep/tasks  
- Pointer edge / level-state interactive ticks (session flags)  
- Keep existing pointer-edge eng budgets (450/700 ms) — pie does not replace them  

### COLD (residual)

- Scene `onUpdate` / anonymous systems  
- Everything not HOT, not deferred UI  

### Rules

| Rule | Detail |
|------|--------|
| Hard wall | Systems **only** (not full eng.update). Tiered e.g. 12–20 ms residual after HOT |
| Resume cursor | COLD continues next tick from last index |
| Quarantine | Single system > Q ms (e.g. 40) → skip N ticks (cap) — **after** first completion |
| React | Always after systems when not pointer-suppressed; **time** it; do **not** skip solely because pie hit wall |
| Patch | Prefer one hook path; if stock loop remains, force gate must **count** ran/skip — never silent pass-through |
| Host | No stacked `eng.update(0)` while systems mutex held (keep single-clock grow-only) |

### Exit criterion

- Light scene: no regression vs flag off  
- Genesis: lower or equal eng.update p95 systems time; pointer edges still deliver; no 5+ min load regression  

## Phase 2 — Main COD alignment (parallel track, not WSP)

Documented here so pie is not asked to solve them:

- Play cook near feet only; no permanent burst on soft-hydrate queue  
- Soft attach rate ≤ play cook capacity  
- Post-seal SQ heal: stop spam when didHit=false with full map in-scene (diagnose root, don’t rebuild thrash)  
- Event-card map-U: keep `fe4f24a` law; fix remaining boards if flip still wrong after seal  

## Rollout

1. Land Phase 0 + 0.5 on `dev-latest` (meters only).  
2. Capture Genesis + PokerClub with `[wsp0]` / `[wsp05]` on — confirm encode vs main apply share.  
3. Fix the dominant cost (dirty send encode and/or main apply) **before** systems pie.  
4. Land Phase 1 behind **default off** only if systems remain a real share.  
5. Default on only after metrics + smoke (pointer, fishing PE, scene UI, multiplayer chat).  
6. Deploy CDN with commit SHA in build banner so prod ≠ tip confusion never repeats.

## Explicit anti-patterns (do not reintroduce)

- Force-ready at 90% to “fix” multi-minute bars without cook/attach caps  
- `pieHook=1 ran=0` as health  
- Skipping react when systems > 14 ms every cooperative tick  
- Multi-shape expand → `failedCookFp` on budget miss  
- Dual island+scene media publish (keep scene-preferred LiveKit)  

## References

- Frame pipeline: `docs/FRAME_PIPELINE_COD.md`  
- Scene law: `.grok/skills/scene-bundle-is-law`  
- Revert tip: stall stack reverts after `fe4f24a` (see git log `Revert "feat(worker): Worker System Pie…"`)
