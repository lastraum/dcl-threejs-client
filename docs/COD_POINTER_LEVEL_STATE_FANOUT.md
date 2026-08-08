# COD fan-out — level-state pointer / ground VFX (platform law)

**Date:** 2026-08-07  
**Branch:** `fix/sync-entity`  
**Bar:** AGENTS.md COD · scene-bundle-is-law · FRAME_PIPELINE_COD  
**Agents:** explore (client path) · explore (bundle) · plan · COD review  

---

## Platform law (one paragraph)

Empty-ground IA_POINTER is **PlayerEntity PET** with **`hit.entityId = 0`**, not an invented PE mesh and not `getClick`. Aim is **live CameraEntity × PrimaryPointerInfo.worldRayDirection ∩ y=0**. Scene systems read **`isPressed` arm on DOWN and fall on UP**. Client must complete **both** edges cheaply (systems only on level-state; no full match-HUD react-ecs thrash on the **hold window**), then **CRDT egress** for any MeshRenderer/Material dirtied on UP, then **peel-only** on main. Bundle gates (match active, worker/soldier selected) are **scene-correct no-disc**, not client bugs.

## Scene law (−16,124 bundle)

```text
DEFAULT MOVE + VFX (not isTriggered, not getClick):
  isPressed DOWN → arm; HS(hit.entityId)→jT; Jr = Cam×PPI∩y=0 (oB)
  isPressed UP   → if !drag && !jT → nQ(ground)
  nQ: only selected workers/soldiers; else return (no td)
  nQ → td → kK green cylinder (parked y=-10 until kK)

isTriggered(IA_POINTER, PET_DOWN) + Ud() — ARMED MODES ONLY:
  patrol (tq) / attack-move (lq) → td(ground)   # VFX on DOWN edge
  spawn/rally (ZK), place (dQ), repair cancel (eq) → no td
  gates: mode flags, Qr UI, HS (attack-move), match active
```

**Do not diagnose default move disc as “isTriggered failed.”**  
`isTriggered` is true only on the inject `eng.update` that carries that PET; no IA_POINTER reassert by design.

## Ranked actions (review survivors)

| # | Action | Status |
|---|--------|--------|
| ① | Cheap sticky press + **guaranteed UP** isPressed systems; level-state **hold** must not force 60Hz react-ecs | **Implemented** (hold flag + defer) |
| ② | Prove Cam/PPI/hit0 on UP that logs | Logs + poses already; prove in retest |
| ③ | Read MeshRenderer Δ → peel once / delete excess | Single eng.update on UP; poll after UP kept until Δ proves otherwise |

## Kill-list (do not re-add)

- getClick as ground VFX path  
- Invented PE ground mesh  
- hitEntity = PlayerEntity on empty ground  
- scene-name forks  
- UI settle / fingerprint on level-state  
- positive-dt edge as VFX “fix”  
- second eng.update order lottery (removed)  
- dual peel as permanent design  

## Pass/fail retest contract

**Setup:** match **active**, **worker/soldier selected**, look at board, click dirt.

**PASS (client edge ready):**

```text
level-state edge done phase=down ...
level-state edge done phase=up ...     # must appear (or …(budget-timeout))
level-state UP isPressed-path — … ground=(x,z) ppi=1 cam=1 hitEntity=0 Δ=?
FPS not crushed by hold thrash
```

| Observation | Verdict |
|-------------|---------|
| No `phase=up` edge-done | **Client P0** (UP starved) |
| `phase=up` + good ground + Δ=0 + **no unit selected** | **Scene gate PASS** |
| `phase=up` + good ground + Δ=0 + **unit selected** | **Client** systems/egress |
| Δ≥1, invisible disc | **Peel/depth** only then |

## Related commits

- `a9c701c` — hitEntity=0, isPressed path naming  
- `46ebcf5` — edge-only react-ecs suppress (incomplete hold window)  
- **This fan-out implement** — hold-window defer + UP completion log before egress + delete second update  
