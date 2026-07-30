# Scene UI — COD / AAA layout + paint policy

**Status:** platform law on `yoga-revamp`  
**Bar:** [AGENTS.md](./AGENTS.md) COD · [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Related:** hit-map from Yoga boxes · structured mount snapshot · FocusOwner primary-only UI  
**Last updated:** 2026-07-29  

---

## One-line law

> **Worker react-ecs authors UI. Main Yoga is the sole layout authority (flexbox math). DOM paints Yoga boxes. Hit-map is Yoga geometry.**  
> **Dirty = entity ∪ descendants** on any Ui* change (transform, background, UV, text, PE, …).  
> **Cousins never dirty each other** — multiple panels under one `#scene-ui-root` / canvas `0` stay independent unless the scene state writes both.  
> Full Yoga / Forest paint only on topology remount or dirty dominating the mount; steady = Reuse/RefineAbsolute + Patch seeds.  
> No second layout invents sizes except explicit **measure**. PE: live + same-frame snapshot lag-fill only.

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
| **Pointer open (sceneUi, mount grew)** | Flush dt≈1/20 until fingerprint stable + !parked + !micro; phase-4 **full paint** flag |
| **Pointer open (mesh, grew / mount≥60 / poseWait)** | Same settle; phase-4 **uiMountFullPaint** → main Forest once |
| **Pointer open (mesh, small)** | dt=0, ≤4 passes, stableNeeded=1 |
| **Pointer selection (same mount)** | dt=0, ≤2 passes — never open multipass (collapses menus) |
| **Cooperative dirty** | Fingerprint delta → partial snapshot → **no** full paint invalidate → steady Patch |
| **Steady** | LayoutMode Reuse/RefineAbsolute; PaintMode Patch when collapsed≈0 |
| **Remount / phase-4** | Invalidate layout+visual+PE; Forest first paint |

### Why positive dt on large mesh modals (root, not bandaid)

Shop open parks content at `left≥virtualWidth` and tweens to center.  
`eng.update(0)` freezes those tweens → phase-4 snapshot freezes empty shell @346 + content @2146.  
Main must not invent `dx` to merge twins. **Worker advances time until fingerprint (incl. position) is stable**, then snapshot.

---

## Dirty scope (platform law)

```text
seed = entities whose visual key OR layout transform fingerprint changed (or left mount)
paintDirty = expand(seed → entity ∪ descendants)   // cousins excluded
layoutDirty = expandLayoutBranch(layoutSeeds)
  // absolute: entity ∪ descendants
  // flex: also parent ∪ its descendants (sibling reflow) — still not cousin roots
Patch paints dirty *seeds* only; renderEntityTree walks each seed's descendants.
```

| LayoutMode | When |
|------------|------|
| `Full` | Mount/layoutKey miss, missing boxes, layoutDirty too large for refine |
| `RefineAbsolute` | Local absolute layout dirties, budget OK, healthy seed |
| `Reuse` | layoutKey hit or visual-only (no layout seeds) + last full boxes |

| PaintMode | When |
|-----------|------|
| `Forest` | First paint / remount; no seeds; dirty ≥ ~45% mount; missing visible boxes |
| `Patch` | Local dirty seeds + descendants only — **not** full canvas because another panel changed |

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
10. ~~Mesh / sceneUi open: fingerprint-stable flush + wall min; refuse exit while parked/micro (incl. relative 6×6 under full shell)~~ ✅  
11. ~~**Deleted** `alignParkedModalTwinBoxes` (client pose invent) — stay deleted~~ ✅  
12. ~~**Deleted** under-paint `setTimeout` recovery (second clock)~~ ✅  
13. ~~**Deleted** off-canvas large-modal paint exception~~ ✅  

---

## Dual-root shop (fishing inventory / vending)

```text
Open: shell@left≈346 + content@left≥1920 until open tween finishes.
Main does NOT invent dx (no twinAlign). Paint ECS Yoga boxes only; fully-off stays hidden.
Worker flush advances eng.update(dt) until fingerprint stable AND not dual-parked / micro.
Then phase-4 snapshot. Cooperative dirty after that — cousins independent.
```

---

## QA oracles

| Action | Expect |
|--------|--------|
| Tutorial mesh open | short flush → phase-4 mid-open (may be ~7×7) → **early Tween+UI egress** → open-scale loop (TweenState + eng.update until !micro or ~2.4s) → **second full paint** → `peOnModal≥1`. Logs: `open-scale early egress`, `open-scale progress`, `open-scale finish`. |
| Tutorial re-click mount 121→121 | `reshow` settle + full paint; not minutes of blank |
| Paginate how-to-play | selection settle `dt=0.000`; X + page dots stay; PE remain |
| Vending mesh open | content on-screen first paint (no twinAlign); not tutorial-only |
| Reeling bars | Patch/RefineAbsolute, not Forest every UV tick |
| CBD splash | PE deletes cleanly |

---

## Non-goals

- Pure React layout on main  
- CSS flex dual authority  
- Client twin-merge / pose invent  
- setTimeout re-layout as product law  
