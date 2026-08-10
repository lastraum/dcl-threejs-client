# Worker System Pie v2 — design only (not implemented)

**Status:** design / do not ship until instrumented and flag-gated.  
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

1. Land Phase 0 on `dev-latest` (meters only).  
2. Capture Genesis with logs on.  
3. Land Phase 1 behind **default off**.  
4. Default on only after metrics + smoke (pointer, fishing PE, scene UI, multiplayer chat).  
5. Deploy CDN with commit SHA in build banner so prod ≠ tip confusion never repeats.

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
