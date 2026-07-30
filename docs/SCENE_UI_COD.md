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
10. ~~Mesh **and sceneUi** large-modal open: positive dt + fingerprint-stable + refuse exit while parked~~ ✅  
11. ~~**Deleted** `alignParkedModalTwinBoxes` (client pose invent)~~ ✅  
12. ~~**Deleted** under-paint `setTimeout` recovery (second clock)~~ ✅  
13. ~~**Deleted** off-canvas large-modal paint exception~~ ✅  
14. ~~alignParkedModalTwinBoxes (texture-aware)~~ ✅ — dual ECS panels → one paint modal when inject freezes park  

---

## Dual-root shop (fishing inventory / vending)

```text
Open: shell@left≈346 (color chrome + PE) + content@left≥1920 (icons/X) in the same mount.
Inject path skips exports.onUpdate → open tweens often never leave park during pointer flush
(eng.update(dt) alone freezes dual pose → empty PE shell, content fully-off-hidden).

Worker still runs large-modal flush (mesh + sceneUi mount≥100) with positive dt.
Main Yoga paint resolves dual ECS panels into **one visible modal**:
  alignParkedModalTwinBoxes — translate texture-rich subtree onto shell origin (layout boxes
  only; ECS pose unchanged) and collapse lean shell. Texture count, not color fills.
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
