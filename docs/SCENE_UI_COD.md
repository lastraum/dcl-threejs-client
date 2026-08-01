# Scene UI — COD / AAA layout + paint policy

**Status:** platform law on `yoga-revamp`  
**Bar:** [cod_prompt.md](./cod_prompt.md) (read every evaluation) · [AGENTS.md](./AGENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Related:** hit-map from Yoga boxes · structured mount snapshot · FocusOwner primary-only UI  
**Last updated:** 2026-07-30 (hide / park / unmount law)  

---

## One-line law

> **Worker react-ecs authors UI. Main Yoga is the sole layout authority (flexbox math). DOM paints Yoga boxes. Hit-map is Yoga geometry.**  
> **Dirty = entity ∪ descendants** on any Ui* change (transform, background, UV, text, PE, …).  
> **Cousins never dirty each other** — multiple panels under one `#scene-ui-root` / canvas `0` stay independent unless the scene state writes both.  
> Full Yoga / Forest paint only on topology remount or dirty dominating the mount; steady = Reuse/RefineAbsolute + Patch seeds.  
> No second layout invents sizes except explicit **measure**. **PointerEvents** lead: live + same-frame snapshot lag-fill only (not portable experiences).

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
| PointerEvents lead | Live + snapshot lag-fill | Forever-live snapshot |
| UiText wrap | Authored `textWrap` (default **TW_WRAP**) | Invent `nowrap` from char count / PE |

**Reject:** pure React re-host · dual Yoga+CSS · per-scene branches · invent parked-panel pose · `plainLen≤48` single-line invent.

---

## Phase model

| Phase | Behavior |
|-------|----------|
| **Hydration** | Commit mount only — no Yoga/DOM thrash |
| **Pointer open (sceneUi, mount grew)** | Flush dt≈1/20 until fingerprint stable + !parked + !micro; phase-4 **full paint** flag |
| **Pointer open (mesh)** | grow **or** dual-park **or** scale-seed **or** no modal on-canvas → open settle; else brief tween settle. No mount-count bands. |
| **Pointer selection / close (same mount)** | dt=0 reconcile + **brief positive-dt tween settle (any UI size)** — wall + fp-stable exit |
| **Cooperative dirty** | Fingerprint delta → partial snapshot → **`forceFullPaint=false` always** → steady Patch |
| **Steady** | LayoutMode Reuse/RefineAbsolute; PaintMode Patch when collapsed≈0 |
| **Remount / phase-4** | Topology membership change → Forest once; phase-4 `fullPaint` once per open burst (~400ms throttle) |
| **Open-scale** | ≤3 UI snapshots (seed full → mid soft → final); seed+final fire-and-forget under pointer; micro wall **~500ms**; **dual-park wall ~1.6s** + wall-clock yields (Tween RTT); cooperative **followup fullPaint** while micro/park (**~5s**, re-armed on inject-complete / deliver-done if still mid-open). Main **force-pushes TweenState during pointerAwaiting** so open-scale can unpark (never defer TweenState until deliver-done). |

### Explorer-close pipeline (COD speed law)

```text
click → short settle → phase-4 Forest ONCE (remount)
     → open-scale: Tween RTT, coalesce snapshots (not N Forests)
     → cooperative: partial + Patch only
     → unpark: sticky (on-canvas Yoga + data-ui-parked) → one Forest if needed
```

**Reject:** cooperative forceFull every dual-root tick · open-scale fullPaint every pass · mount-count policy.

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

## PointerEvents lead law (not portable experiences)

> **PE** in this file = **PointerEvents** only. Prefer **PointerEvents** / **UiPointer** in new prose.  
> Portable experiences = **PX** — see [PORTABLE_EXPERIENCE_COD.md](./PORTABLE_EXPERIENCE_COD.md).

```text
1. live non-empty     → live wins; mark seen; drop snapshot
2. live empty + mounted + snapshot PointerEvents → snapshot (fold lag)
3. live empty + seen + no snapshot    → deleted
4. else                               → none
```

clearLww only for **components present in snapshot rows**.  
Still-mounted PointerEvents delete: `applyWorkerUiMountSnapshot` when transform without PointerEvents.  
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

## Hide vs park vs unmount (platform law)

Three different “gone” states. **Never conflate them.**

| State | Worker | Mount set | DOM under root | Hits |
|-------|--------|-----------|----------------|------|
| **Hide** | `display: none` / opacity≈0 | **Still mounted** | Node may stay; `display:none` | Off |
| **Park** | Transform off virtual canvas (`left≥1920`, below fold, etc.) | **Still mounted** | **Held under `#scene-ui-root` / ECS parent** with Yoga pose stored; `display:none` + inert + `data-ui-parked` (must not steal canvas orbit/click) | Off |
| **Unmount** | react-ecs removed entity | **Not mounted** | **releaseNode / purge** (recycle-safe) | None |

```text
UNMOUNT  = entity left the worker mount set only.
PARK     = same entity, different pose (dual-root open tween, HUD park).
HIDE     = same entity, display/opacity authoring.
```

**Rules:**

1. **Park ≠ unmount.** Off-screen transform never drops the entity from the root tree.
2. **Park keeps Yoga geometry** on the shell; unpark is style/pose update, not invent pose.
3. **Park must use `display:none` + no PE** — never leave interactive descendants that steal WebGL orbit/click (`pointer-events:auto` under `pe:none` parent still hits).
4. **Do not materialize full off-canvas subtrees every paint** — freezes main thread (same symptom as dead pointer).
5. **Unmount only** when id leaves mount → DOM purge required (anti ghost PE / id recycle).
6. **No client twinAlign** — parked pose comes from ECS only.
7. Off-canvas park is DOM/hit only (no PE steal). Worker open settle must **not** size-gate on panel area.

---

## Off-canvas panel open (park pose — NOT “dual-root”)

```text
Scene authors ONE panel: position off virtual canvas, then tween on.
Client does NOT invent a second copy / shell+twin from panel sizes.
Main does NOT invent dx (no twinAlign). Off-canvas = PARK (held + Yoga pose), not unmount.
Worker flush: fingerprint stable only — panel size must not block inject/open.
```

### poseReady law (`uiOpenPose.ts`)

```text
isOpenPoseBlocked := always false  (size gates killed)
poseReady         := fingerprintStable only
needsOpenScale    := always false
```

Tests: `npm run test:ui-open-pose` (may need update after size-gate kill).

---

## QA oracles

| Action | Expect |
|--------|--------|
| Tutorial mesh open | short flush → phase-4 mid-open (may be ~7×7) → **early Tween+UI egress** → open-scale loop (TweenState + eng.update until !micro or ~2.4s) → **second full paint** → `peOnModal≥1`. Logs: `open-scale early egress`, `open-scale progress`, `open-scale finish`. |
| Tutorial re-click mount 121→121 | `reshow` settle + full paint; not minutes of blank |
| Paginate / close any modal | selection: dt=0 reconcile + `tween settle` (any mount size); X + page dots stay; close anim finishes |
| Vending mesh open | content on-screen first paint (no twinAlign); open-scale progress>0 or followup unpark; peOnModal≥1; not blank grid icons |
| Reeling bars | Patch/RefineAbsolute, not Forest every UV tick |
| CBD splash | PE deletes cleanly |

---

## Non-goals

- Pure React layout on main  
- CSS flex dual authority  
- Client twin-merge / pose invent  
- setTimeout re-layout as product law  
