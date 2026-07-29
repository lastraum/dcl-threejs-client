# Scene UI — COD / AAA layout + paint policy

**Status:** platform law on `yoga-revamp`  
**Bar:** [AGENTS.md](./AGENTS.md) COD · [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Related:** hit-map from Yoga boxes · structured mount snapshot · FocusOwner primary-only UI  
**Last updated:** 2026-07-29  

---

## One-line law

> **Worker react-ecs authors UI. Main Yoga is the sole layout authority. DOM paints Yoga boxes. Hit-map is Yoga geometry.**  
> No second layout invents sizes except explicit **measure** (text, background fill-intent under slots).  
> No PE authority except **live projection**, with **same-frame mount-snapshot fill** only while live lags.  
> Full Yoga on topology change; refine absolute dirties only with a healthy seed; patch only when collapsed≈0.

---

## Architecture (not alternatives)

```text
Worker                          Main
──────                          ────
react-ecs UiEntity tree   →     CRDT / mount snapshot
UiTransform (Yoga-shaped) →     layoutUiTree (Yoga)
UiBackground / UiText     →     DOM paint + styles
PointerEvents             →     hit-map + --interactive
```

| Layer | Authority | Not |
|-------|-----------|-----|
| Authoring | Worker react-ecs | Main inventing widgets |
| Layout math | Yoga on main from `UiTransform` | CSS flex dual-semantics, pure React re-host |
| Paint | DOM shells nested by ECS parent | Canvas UI (optional future) |
| Hits | Yoga `LayoutBox` → screen | `getBoundingClientRect` as primary |
| PE | Live projection; snapshot lag-fill | Forever-live snapshot after live seen |

**Reject:** main-thread React re-host · dual Yoga+CSS max-box · per-scene layout branches.

---

## Phase model (seal like static colliders)

| Phase | Behavior |
|-------|----------|
| **Hydration** | Commit mount only — **no** Yoga/DOM thrash |
| **Pointer open (UI PE)** | Full touch + full snapshot → clearLww **per (entity,component)** → commitMount → full Yoga + Forest |
| **Pointer open (mesh PE, large mount)** | ≥2 stable react-ecs passes (not 1 seed-match) before snapshot — fishing shop ~700 |
| **Cooperative dirty** | Fingerprint delta → partial snapshot → paint if content epoch dirty |
| **Steady** | LayoutMode Reuse/RefineAbsolute; PaintMode Patch when collapsed≈0 |
| **Remount / empty** | Invalidate layout+visual+PE tombstones; full path next paint |
| **Under-paint recovery** | At most **2** layout-invalidating repaints if `pooled ≪ visibleYoga` (first-open shell only) |

### LayoutMode / PaintMode

| LayoutMode | When |
|------------|------|
| `Full` | Mount/layoutKey miss, missing boxes, unhealthy collapsed seed |
| `RefineAbsolute` | Absolute dirties only, budget OK, healthy seed |
| `Reuse` | layoutKey hit or visual-only with last full boxes |

| PaintMode | When |
|-----------|------|
| `Forest` | Default after Full; growth/shrink; collapsed>4 |
| `Patch` | Steady + few dirties + collapsed≈0 + repaired=0 |

Debug: `?sceneuidebug` → `layoutMode=` / `paintMode=` / `repaired=` / `collapsed=`.

---

## PE lead law (single helper)

```text
1. live non-empty     → live wins; mark seen; drop snapshot for entity
2. live empty + mounted + snapshot PE → snapshot (fold lag)
3. live empty + seen + no snapshot    → deleted (splash)
4. else                               → none
```

- **clearLww:** only components **present in snapshot rows** (never wipe PE on bg-only dirty).  
- **Still-mounted PE delete:** `applyWorkerUiMountSnapshot` belt when transform row ships without PE.  
- **Any** mount set change + **any** `ingestMountSnapshot` → clear `liveSeen`.

---

## Measure vs repair

| Path | Role |
|------|------|
| `applyTextMinSize` / `applyInputMinSize` | Yoga measure for text/fields |
| `applyBackgroundMinSize` + one expand re-layout | Full-bleed AUTO icons under POINT slot parents; **never** corner-pinned badges |
| `repairCollapsedLayoutBoxes` | **Authored only:** POINT/%, opposite edges, slot %≥90 — **no AUTO invent** |

---

## Kill-list (status)

1. ~~Visual key texture src~~ ✅  
2. ~~clearLww per-component rows~~ ✅  
3. ~~Yoga bg minSize + expand (badge-safe)~~ ✅  
4. ~~Remove collapse re-layout thrash~~ ✅ (under-paint recovery capped ≤2)  
5. ~~LayoutMode / PaintMode named~~ ✅  
6. ~~liveSeen on any mount change~~ ✅  
7. ~~repairCollapsed: no AUTO slot-fill~~ ✅  
8. ~~Scale-tween geometry restore deleted~~ ✅  
9. ~~Fingerprint unit tests~~ ✅ `npm run test:scene-ui`  
10. ~~Mesh large-modal ≥2 stable react-ecs passes~~ ✅  
11. ~~Pixel atlas UV when natural size known~~ ✅  

### Remaining watch (not thrash layers)

| Item | Note |
|------|------|
| Dual shop roots | Scene parks twin panel; paint both when both on-screen → ghost. Prefer scene settling + mesh multi-pass; do not invent client merge. |
| Click selection animation | Scene-owned; ensure visual key covers selection dirties if still broken after open settles. |
| `repaired=` in debug | Should trend down after Yoga measure; spike on open is ok for %/edges. |

---

## QA oracles

| Action | Expect |
|--------|--------|
| Fishing shop mesh open | Grids + X on first paint (or ≤~100ms recovery); not empty shell for seconds |
| Close → open | Icons + X still present |
| Reeling bars | `layoutMode=Reuse` or `RefineAbsolute` on UV ticks |
| CBD splash PE | Click removes catcher |
| Secondary FocusOwner | No scene UI paint |

---

## Non-goals

- Pure React layout on main  
- CSS flex as dual authority  
- Canvas UI rewrite for v1.x  
- Plaza-only / fishing-only branches  
