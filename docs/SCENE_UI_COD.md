# Scene UI — COD / AAA layout + paint policy

**Status:** platform law (draft from Yoga vs React review + reopen bugs)  
**Bar:** [AGENTS.md](./AGENTS.md) COD · [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Related:** hit-map from Yoga boxes · structured mount snapshot · FocusOwner primary-only UI  
**Last updated:** 2026-07-29  

---

## One-line law

> **Worker react-ecs authors UI. Main Yoga is the sole layout authority. DOM paints Yoga boxes. Hit-map is Yoga geometry.**  
> No second layout invents sizes except explicit **measure** (text today; image optional).  
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
| Paint | DOM shells nested by ECS parent | Canvas UI (optional future, not required) |
| Hits | Yoga `LayoutBox` → screen | `getBoundingClientRect` as primary |
| PE | Live projection; snapshot lag-fill | Forever-live snapshot after live seen |

**Reject:** main-thread React re-host of scene UI · dual Yoga+CSS max-box · per-scene layout branches.

**Parity:** Explorer behavior for ECS UI — not identical Unity internals.

---

## Phase model (seal like static colliders)

| Phase | Behavior |
|-------|----------|
| **Hydration** | Commit mount only — **no** Yoga/DOM thrash |
| **Pointer open (phase-4)** | Full touch + full snapshot → clearLww **per (entity,component) row** → apply → commitMount → **one** full Yoga + full render |
| **Cooperative dirty** | Fingerprint delta → partial snapshot → touch only dirty entities → paint if content epoch dirty |
| **Steady** | Layout key hit → reuse boxes; visual dirties → patch DOM; absolute layout dirties → refine |
| **Remount / empty** | Invalidate layout+visual+PE tombstones; full path next paint |
| **Seal never thrash** | No `setTimeout` re-layout loops as product law; no full Yoga every PE tick on 700 nodes |

### When full Yoga is required

- Mount set key changed  
- `layoutKey` miss (display / size / parent / flex topology)  
- Visible entities missing boxes after refine/cache  
- Seed/cache heavily collapsed (**temporary gate** — delete when measure is complete)

### When full Yoga is forbidden (COD)

- UV-only reeling bars with stable layout seed  
- Color/text-only dirties with healthy last full boxes  
- Hydration attach bandwidth

---

## Smell → root → fix → kill

### 1. `repairCollapsedLayoutBoxes` (second layout authority)

| | |
|--|--|
| **Smell** | Invents sizes Yoga did not produce (slot fill, opposite edges, % under cells). |
| **Root** | Yoga has text/input measure only — **no image measure**. AUTO absolute icon leaves → 0×0. |
| **Fix (root)** | In `layoutUiTree`: for leaves with `UiBackground` texture + AUTO width/height, set min size from parent slot or default icon cell once texture known; or stretch children under fixed-size flex parents via Yoga `alignItems` / explicit scene sizes. Prefer **measure/minSize in Yoga** over post-pass invent. |
| **Fix (keep short-term)** | Restrict repair to: (a) opposite edges, (b) explicit POINT/%, (c) absolute AUTO under parent ≤200×200 **only until measure lands**. |
| **Kill** | Delete slot-fill branch when measure covers inventory/vending icons; log `repaired=` should trend to ~0. |

### 2. `scheduleCollapseRelayout` (second clock)

| | |
|--|--|
| **Smell** | 48ms timer re-Yoga after high collapse — same class as VC stage-freeze timers. |
| **Root** | First paint before topology/content stable; poisoned layout cache of 0×0 cells. |
| **Fix (root)** | Complete **layout + visual fingerprints** (texture src ✅); force full Yoga on mount growth / display:none→flex; never cache boxes with collapsed ≫ 0. Worker multi-pass already stabilizes fingerprint — main should paint once per stable fingerprint, not invent a second timer. |
| **Kill** | Remove `collapseRepaintQueued` when first-open grids stay filled without it (QA fishing shop). |

### 3. Layout path gates (cache / refine / full / patch / under-paint)

| | |
|--|--|
| **Smell** | Too many boolean gates; hard to know which path painted. |
| **Root** | Performance legitimately needs refine+patch on large trees; gates grew without a named mode enum. |
| **Fix** | Collapse to explicit **LayoutMode**: `Full` \| `RefineAbsolute` \| `Reuse` and **PaintMode**: `Forest` \| `Patch`. One function chooses mode from pure inputs (mountChanged, layoutDirty count, collapsed, missingVisible). Delete ad-hoc safety renders once mode selection is correct. |
| **Rule** | `Patch` only if `collapsedVisible ≤ 4` && `repaired === 0` && dirty budget OK && paintCount after remount reset. |

### 4. PE multi-authority (snapshot / liveSeen / clearLww / belt-and-suspenders)

| | |
|--|--|
| **Smell** | Four places decide whether entity has PE. |
| **Root** | Snapshot is PUT-only; partial dirty must not wipe PE; splash PE delete must stick. |
| **Fix (done / keep)** | clearLww **only for components present in snapshot rows** (not all Ui* on every entity). |
| **Fix (next)** | **PE lead law:** (1) live non-empty → live wins, mark seen, drop snapshot for that entity. (2) live empty + authoritative + snapshot non-empty → snapshot (lag). (3) live empty + seen + no snapshot → deleted. (4) On **any** `ingestMountSnapshot`, clear liveSeen (reopen recycle). |
| **Belt-and-suspenders** | Keep PE delete for transform-in-snapshot without PE row (scene removed PE). Document as sole PE-delete path for still-mounted entities — not “extra clearLww.” |
| **Kill** | Extra PE clears in release paths that fight snapshot; largeRemount heuristics that only clear PE sometimes — prefer: **any mount key change** clears liveSeen. |

### 5. Incomplete visual fingerprint (historical)

| | |
|--|--|
| **Smell** | Bare `:tex` without URL → early-out while icons resolve. |
| **Root** | Paint skip keys not matching worker fingerprint fidelity. |
| **Fix (done)** | `entityUiVisualPaintKey` includes `extractUiTextureSrc`. |
| **Rule** | Any field that changes DOM/Yoga must appear in layout or visual key. Add tests for texture src + UV + PE. |

### 6. No image measure in Yoga

| | |
|--|--|
| **Smell** | Icons rely on repair / timers. |
| **Root** | `applyTextMinSize` / `applyInputMinSize` only. |
| **Fix** | `applyBackgroundMinSize` for AUTO leaves: if parent has concrete size and child is absolute fill intent, min = parent; if texture natural size cached, optional intrinsic for CENTER mode only. Must not balloon NEW badges (explicit POINT size always wins). |
| **Kill** | Most of `repairCollapsed` slot-fill. |

### 7. Scale-tween geometry restore (lastLayoutBoxMap)

| | |
|--|--|
| **Smell** | Restores previous panel size when Yoga shrinks catastrophically. |
| **Root** | Scale tween on UI nodes is rare; can hide real layout bugs. |
| **Fix** | Keep only if a known scene pattern needs it; gate on explicit scale-related layout dirty; otherwise delete and fix transform pipeline. |
| **Kill** | Broad “restore any shrink” if no repro without it. |

---

## Target paint pipeline (after cleanup)

```text
paint(view):
  if !contentDirty && keys match → return
  collect records / forest / layoutKey / visualKey / dirties

  layoutMode =
    mountOrLayoutKeyChanged || missingVisible || seedCollapsed>N → Full
    else layoutDirties absolute-only within budget → RefineAbsolute
    else → Reuse

  boxes = run(layoutMode)
  // measure-owned only; repair → deprecate
  visible = filter display/opacity
  paintMode = (stable && few dirties && collapsed≈0) ? Patch : Forest
  paint(paintMode)
  hitMap = from Yoga boxes
```

No `setTimeout` in the law. No dual PE writers. No scene name branches.

---

## QA oracles (platform)

| Scene / action | Expect |
|----------------|--------|
| Fishing shop open | Grid icons first open; close X present; reopen same |
| Fishing reel bars | UV ticks do **not** fullYoga whole modal |
| CBD / plaza splash PE | Click removes catcher; no ghost PE |
| RickRoll CREATOR cards | Text minWidth; labels not blank |
| Flagtag / HUD timers | Dirty text/width without 700-node thrash |
| Secondary FocusOwner | No scene UI paint |

Debug: `?sceneuidebug` — `fullYoga` / `repaired` / `collapsed` / `patchEligible` should trend toward fullYoga only on open/close topology.

---

## Kill-list (ordered)

1. ~~Visual key texture src~~ ✅  
2. ~~clearLww per-component rows (not wipe PE on bg-only dirty)~~ ✅  
3. **Image / AUTO minSize in Yoga** → drop slot-fill repair  
4. **Remove `scheduleCollapseRelayout`** after (3) + QA  
5. **LayoutMode / PaintMode enum** — collapse gate soup  
6. **liveSeen clear on any mount set change** (not only largeRemount)  
7. Revisit scale-tween restore; delete if unused  
8. Fingerprint unit tests (layout + visual)  

---

## Non-goals

- Pure React layout on main  
- CSS flex as dual authority  
- Canvas UI rewrite for v1.x  
- Plaza-only or fishing-only branches  
