# Worker System Pie (WSP) — scene `engine.update` COD law

**Status:** platform law on `dev-latest` (2026-08-09) — parity gap close, not a release cut  
**Bar:** [AGENTS.md](./AGENTS.md) COD · scene-bundle-is-law · Explorer isolation  
**Related:** [FRAME_PIPELINE_COD.md](./FRAME_PIPELINE_COD.md) (main renderer pie) · [OPTIMIZATIONS.md](./OPTIMIZATIONS.md)

---

## Diagnosis (why Genesis multi-second `engine.update`)

Main thread already has a fixed frame pie (`pendingDiff` lanes, 18 ms async deadline). The **worker** still ran every registered `@dcl/ecs` system to completion under one mutex. Explorer does **not**: scene JS is isolated, targets ~**30 Hz**, and under load **drops** — continuous motion lives on display rate.

Abort at 5s and “preempt” only flipped scheduler flags; the JS systems loop **kept running**. Host TriggerArea / Tween inject then scheduled **another** full `eng.update(0)` → death spiral.

---

## Platform law (one paragraph)

> **`engine.update` is a fixed Worker System Pie, not an all-systems barrier.**  
> **HOT** systems always finish: SDK core `@dcl/*` (except react-ecs), SDK event names (`TriggerAreaResultSystem`, `EventSystem`, …), anonymous systems, pointer/level-state edges (all non-UI). Named scene systems default **HOT** until EMA cost proves them expensive ambient.  
> **COLD** runs under a wall budget **after** HOT with a resume cursor; force-progress uses a higher budget, never an unbounded full list.  
> **UI** (`@dcl/react-ecs*`) stays last and throttled when idle.  
> Host grow-only inject is **data plane** — coalesce when systems already in-flight; idle still gets same-message `eng.update(0)`.  
> No scene-name forks.

```text
MAIN rAF  ── pie (motion / PE / async drain) ──► CRDT
WORKER eng.update(dt)
  HOT always  ──►  COLD until budget (resume)  ──►  react-ecs (deferred)
```

| Mode | Hard wall (entire systems pass) |
|------|----------------------------------|
| Cooperative high | **14 ms** |
| Cooperative medium | **18 ms** |
| Cooperative low | **24 ms** |
| Pointer edge | **20 ms** |

**Per-system quarantine:** any system that runs **>40 ms** is skipped for several ticks (cannot abort mid-fn in JS). First overrun can still hitch once; it must not pin every frame.

**Slow log:** automatic `[wsp] SLOW … top=…` when a pass exceeds **80 ms** (no flag required).

---

## Single clock (host inject)

| Before | After |
|--------|--------|
| Every TriggerArea ENTER → `runSceneEngineUpdateNow(0)` full pass | If eng tick already in-flight → queue only |
| Idle worker | Still immediate `eng.update(0)` for same-message onChange (impulse pads) |

---

## Multi-scene secondaries

| Tier | `secondaryTickIntervalMs` |
|------|---------------------------|
| high | **0** (every frame — dense CBD) |
| medium | **33** (~30 Hz Explorer-like) |
| low | **50** (~20 Hz) |

FocusOwner mute unchanged. Continuity (sticky demote) ≠ dual full brains at 60 Hz on low hardware.

---

## Code

| Piece | Path |
|-------|------|
| Pie | `src/shim/worker/workerSystemPie.ts` |
| Loop hook | `installEngineSystemLoopPartition` in `sceneEngineUiScheduler.ts` |
| Bundle patch | `patchEngineSystemLoop.ts` → `__THREEJS_ENGINE_SYSTEM_LOOP__` |
| Inject coalesce | `deliverRendererAppendInbound` in `sceneWorker.ts` |
| Secondary cadence | `secondaryTickIntervalMs` in `dcl/multiScene/caps.ts` |

**Perf:** set `globalThis.__THREEJS_SCENEWORKER_PERF__ = true` in the worker console for `[wsp]` top-system logs every 2s.

---

## Kill-list

- Unbounded all-systems barrier as the only model  
- Force-release mutex mid-`eng.update`  
- Dual full eng.update “to catch up” after timeout  
- Scene-name `if genesis` system skips  
- Throttling HOT input / PET systems to “save FPS”  
- Lowering abort timers as the primary frame control  

---

## Retest

| Case | Pass |
|------|------|
| Genesis walk + fishing UI | No multi-second `engine tick recovery` spam; eng feels live |
| Ground click / PE | Edge not 700ms partial forever |
| Flagtag / combat | HOT gameplay still every tick |
| brainrot pads | Transform/tween HOT |
| Secondaries on medium | Scripts ~30 Hz; meshes sticky |

---

## Explorer parity note

Creator docs: scene update **up to ~30 ticks/s**, may be less under load. WSP COLD resume is that contract. HOT input/SDK core stay live every eng.update so `isPressed` / PE / network core do not miss frames.
