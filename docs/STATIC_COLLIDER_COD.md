# Static colliders — COD / AAA cook-once policy

**Status:** platform law on `feat/aoi-focus-owner`  
**Engine:** PhysX (CCT player + scene solids)  
**Bar:** [AGENTS.md](./AGENTS.md) COD multi-scene continuity  
**Related:** [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) · [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md)  
**Last updated:** 2026-07-27  

---

## One-line law

> **Statics are cooked once into the scene-query structure, then left alone.**  
> Full static SQ rebuild, reinsert-all, and wipe+recook are **forbidden** at play time.  
> MISS / walk-through is a **bug to repair per entity**, not a reason to thrash the tree.

---

## AAA / COD model

| Phase | Behavior |
|-------|----------|
| **Level load** | Cook collision once (`addActor` registers into SQ) |
| **Seal** | Freeze bulk reinsert; **never** `forceDynamicTreeRebuild` |
| **Play** | Unmoved statics are never re-touched |
| **ROOT motion** | Actor global T+R only (entity-local cook) |
| **PART / movers** | Kinematic or fp-gated world-cook via `replaceStaticWithCook` |
| **Stream in (AOI)** | Single `addActor` (+ optional single remove+add for bounds) |
| **Stream out** | Remove that region only |
| **Health soft / MISS** | Log + single-entity repair; **never** rebuild whole tree |

PhysX WASM on plaza-scale scenes (~700–1100+ multi-shape statics) **corrupts** after `forceDynamicTreeRebuild` / reinsert-all: `logStaticCollidersNear` still lists walls, CCT sweeps return **MISS**.

---

## Boot order (platform)

```text
loadScene (worker onStart)
waitForSceneAssets (attach GLBs)
prewarmPhysicsColliders (optional progressive cook — does NOT seal)
spawnLocalPlayer:
  waitForColliderGraphSettle   // pendingMesh → 0 (or soft ≥97% attach)
  extract once (final matrices) // dirty-all only here
  cook missing / unsynced only  // addActor; never wipe all actors
  integrity drain (missing + geom mismatch)
  sealStaticSceneQuery          // freeze reinsert; NO forceDynamicTreeRebuild
  collidersReady = true
world.start()
```

### Seal semantics

`PhysXWorld.sealStaticSceneQuery()`:

1. Disables zero-dt warm sim (`allowZeroDtWarmSim = false`)
2. Sets `allowStaticReinsert = false` (bulk reinsert / tree rebuild frozen)
3. Ensures infinite ground plane
4. Invalidates CCT obstacle cache
5. **Does not** call `scene.forceDynamicTreeRebuild`
6. **Does not** remove+add every static actor

Actors already entered SQ via `addActor` during cook. That is enough.

### Late cooks after seal

Brand-new actors (late GLB / AOI) still:

- `addActor` on first cook
- Optional **single** actor remove+add so SQ bounds match (plaza-safe)
- CCT cache invalidate only

Never: reinsert-all, full tree rebuild, `simulate(0)` warm.

---

## Runtime motion (two sources only)

See [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md).

| Source | PhysX write | SQ |
|--------|-------------|-----|
| **Transform dirty → ROOT** | `setGlobalPose` actor T+R | No reinsert (already in tree) |
| **Animator → PART** | World-cook when coarse hull fp **changes** | `replaceStaticWithCook` / addActor; no full rebuild |
| **else** | nothing | nothing |

Unmoved statics: pose-fp match → **no-op** (`force` must not reinsert them).

---

## Forbidden (kill-list)

| API / pattern | Why forbidden |
|---------------|----------------|
| `forceDynamicTreeRebuild` on static structure | Corrupts WASM SQ at plaza scale → MISS |
| `reinsertAllStaticActorsForSceneQuery` | Mass remove+add softs CCT after ~1 min |
| `rebuildStaticSceneQueryTree` as health/runtime fix | Same as full rebuild |
| `clearGltfStaticActors` / `clearAllSceneStaticActors` on boot seal | Soft hole while recooking |
| `simulate(0)` / zero-dt warm after seal | Corrupts concurrent pose slides |
| Health soft → tree rebuild | Treats MISS as thrash trigger |
| Dirty-all extract every frame / double full extract at seal | Thrash-shaped hitch at ~79% |
| Pose-fp exact match as cook-queue “synced” | Float noise → forever recook queue |
| Content labels (“plaza”, parcel ids) in PhysX | Policy is scene-agnostic |

**Allowed exceptions:**

- Help-panel **manual recook** (`recookPhysicsColliders`) — intentional debug; uses hot-replace, not wipe-first.
- **PART** world-cook for entities whose hull fp changed (fp is the thrash guard).
- **Scale-drift** geom recook — bounded cooldown; geom fingerprint mismatch only.
- **Missing actor** discover — truly absent PhysX actor only.

---

## Symptom → cause → COD fix

| Symptom | Cause | Wrong fix | COD fix |
|---------|-------|-----------|---------|
| Walk-through; walls in near-log | SQ dead after rebuild/reinsert-all | More `forceDynamicTreeRebuild` | Never full rebuild; seal freeze only |
| Soft at play | Seal before attach complete | Wipe + recook | Wait graph; cook missing only |
| Soft after “cook complete” | Clear all actors then partial extract | Rebuild | No wipe on seal path |
| Soft after ~1 min | Reinsert thrash / `simulate(0)` | Rebuild tree | Freeze reinsert; no zero-dt warm |
| Stuck ~79% bar | Pose-fp required for synced | Endless recook | Sync = geom + children live |
| Only plaza soft | Scale amplifies thrash | Scene special-case | Same policy everywhere; plaza is the stress test |

---

## Code entry points

| Concern | Location |
|---------|----------|
| Prepare + seal | `World.prepareCollidersForPlay` |
| Prewarm (no seal) | `World.prewarmPhysicsColliders` |
| Extract (boot) | `World.extractCollidersChunked` — dirty-all only on authoritative boot pass |
| Runtime catch-up extract | Progressive pending only — **no** invalidate-all |
| Seal | `PhysXWorld.sealStaticSceneQuery` |
| ROOT slides | `PhysXWorld.applyStaticColliderPoseUpdates` |
| PART cooks | `PhysXWorld.applyPartColliderMotions` |
| Late single add | `PhysXWorld.addStatic` (post-seal single reinsert) |
| Missing actors | `World.discoverMissingColliderActors` |
| Scale drift | `World.enqueueScaleDriftRecooks` |
| Manual recook | `World.recookPhysicsColliders` |

Deprecated no-ops (must not regain bodies):

- `PhysXWorld.rebuildStaticSceneQueryTree`
- `PhysXWorld.reinsertAllStaticActorsForSceneQuery`

---

## QA checklist (plaza / COD)

- [ ] Log: `static SQ sealed — … rebuild=never` (no forceDynamicTreeRebuild)
- [ ] `sweepFeetY` at spawn **not** MISS while near-log shows walls
- [ ] No `reinsertAll` / rebuild spam after seal
- [ ] Walk Genesis Plaza + fishing solids; no soft after 1–2 min idle
- [ ] Promote / demote neighbor: solids stay, no Missing-actors thrash
- [ ] Freecam free; no void unload
- [ ] FPS recovers to 30–60 after load hitch

---

## Implementation invariant (agents)

Before any PhysX static change, ask:

1. Does this touch unmoved statics after seal? → **No.**
2. Does this call full tree rebuild or reinsert-all? → **No.**
3. Is cook only for missing / geom-changed / PART fp-changed? → **Yes.**
4. Is MISS handled by log + single repair, not thrash? → **Yes.**

If a change makes plaza walk-through while actors still exist, **it is P0** — reverse or fix before shipping.
