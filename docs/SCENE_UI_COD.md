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
> **No client pose invent. No second clocks. Modal open settles on the worker before snapshot.**

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
| Layout math | Yoga from `UiTransform` | CSS dual-semantics · client `dx/dy` twin align |
| Open animation | Worker systems + **positive dt** during large-modal flush | Main setTimeout re-layout · pose snap |
| Hits | Yoga boxes → screen | `getBoundingClientRect` as primary |
| PE | Live + snapshot lag-fill | Forever-live snapshot |

**Reject:** pure React re-host · dual Yoga+CSS · per-scene branches · invent parked-panel pose.

---

## Phase model

| Phase | Behavior |
|-------|----------|
| **Hydration** | Commit mount only — no Yoga/DOM thrash |
| **Pointer open (UI PE)** | Full touch + snapshot after fingerprint stable |
| **Pointer open (mesh PE, mount ≥ 100)** | Flush with **dt≈1/20**, max ~24 passes, **stableNeeded=3** (fingerprint includes position — open tweens must finish) |
| **Pointer open (mesh PE, small)** | dt=0, few passes, stableNeeded=1 |
| **Cooperative dirty** | Fingerprint delta → partial snapshot → paint if dirty |
| **Steady** | LayoutMode Reuse/RefineAbsolute; PaintMode Patch when collapsed≈0 |
| **Remount** | Invalidate layout+visual+PE tombstones |

### Why positive dt on large mesh modals (root, not bandaid)

Shop open parks content at `left≥virtualWidth` and tweens to center.  
`eng.update(0)` freezes those tweens → phase-4 snapshot freezes empty shell @346 + content @2146.  
Main must not invent `dx` to merge twins. **Worker advances time until fingerprint (incl. position) is stable**, then snapshot.

---

## LayoutMode / PaintMode

| LayoutMode | When |
|------------|------|
| `Full` | Mount/layoutKey miss, missing boxes, unhealthy seed |
| `RefineAbsolute` | Absolute dirties, budget OK, healthy seed |
| `Reuse` | layoutKey hit or visual-only + last full boxes |

| PaintMode | When |
|-----------|------|
| `Forest` | After Full; growth/shrink; collapsed>4 |
| `Patch` | Steady + few dirties + collapsed≈0 + repaired=0 |

---

## PE lead law

```text
1. live non-empty     → live wins; mark seen; drop snapshot
2. live empty + mounted + snapshot PE → snapshot (fold lag)
3. live empty + seen + no snapshot    → deleted
4. else                               → none
```

clearLww only for **components present in snapshot rows**.  
Still-mounted PE delete: `applyWorkerUiMountSnapshot` when transform without PE.  
Any mount change + any `ingestMountSnapshot` → clear liveSeen.

---

## Measure vs repair

| Path | Role |
|------|------|
| Text / input minSize | Yoga measure |
| `applyBackgroundMinSize` + expand | Full-bleed AUTO icons under POINT slots; never corner-pinned badges |
| `repairCollapsed` | Authored POINT/%, opposite edges, slot %≥90 only — **no AUTO invent** |

---

## Kill-list (COD complete — no bandaids)

1. ~~Visual key texture src~~ ✅  
2. ~~clearLww per-component~~ ✅  
3. ~~Yoga bg minSize (badge-safe)~~ ✅  
4. ~~repair AUTO invent removed~~ ✅  
5. ~~Scale-tween geometry restore deleted~~ ✅  
6. ~~LayoutMode / PaintMode~~ ✅  
7. ~~liveSeen on mount change~~ ✅  
8. ~~Fingerprint unit tests~~ ✅ `npm run test:scene-ui`  
9. ~~Pixel atlas UV~~ ✅  
10. ~~Mesh **and sceneUi** large-modal open: positive dt + fingerprint-stable + refuse exit while parked~~ ✅  
11. ~~**Deleted** `alignParkedModalTwinBoxes` (client pose invent)~~ ✅  
12. ~~**Deleted** under-paint `setTimeout` recovery (second clock)~~ ✅  
13. ~~**Deleted** off-canvas large-modal paint exception~~ ✅  
14. ~~**Deleted** suppress shell while content parked~~ ✅ — only zero lean twin when **both** on-screen + texture-rich content wins  

---

## Dual-root shop (fishing inventory / vending)

```text
Open: shell@left≈346 (color chrome) + content@left≥1920 (icons) until open tween finishes.
Main MUST NOT invent dx to merge twins.
Worker flush (mesh PE or sceneUi bag open, mount≥100) advances eng.update(dt≈1/20)
until fingerprint stable AND no dual park remains, then phase-4 snapshot.
Main paints on-canvas ECS pose only. If both roots still overlap on-screen after settle,
suppressEmptyOverlappingModalTwin zeros the texture-poor shell (not pose invent).
```

---

## QA oracles

| Action | Expect |
|--------|--------|
| Fishing vending mesh open | Log `largeModal` + flush `dt=0.050`; content on-screen in **first** paint (grids + icons + X + UV) |
| Inventory bag sceneUi open | Log `sceneUi largeModal open flush`; same first-paint bar |
| Close → open | Settles again; no PE-only blocker, no blank icons |
| Reeling bars | Reuse/RefineAbsolute, not Full every UV tick |
| CBD splash | PE deletes cleanly |

---

## Non-goals

- Pure React layout on main  
- CSS flex dual authority  
- Client twin-merge / pose invent  
- setTimeout re-layout as product law  
