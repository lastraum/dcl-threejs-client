# Static colliders — COD / AAA cook-once policy

**Status:** platform law on `feat/aoi-focus-owner`  
**Engine:** PhysX (CCT player + scene solids)  
**Bar:** [AGENTS.md](./AGENTS.md) COD multi-scene continuity  
**Related:** [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) · [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md)  
**Last updated:** 2026-07-27  

---

## One-line law

> **Statics are cooked once, SQ-committed once at seal, then left alone.**  
> `forceDynamicTreeRebuild` and **runtime** reinsert-all / wipe+recook are forbidden.  
> MISS / walk-through is a **bug to repair per entity**, not a reason to thrash the tree.

---

## AAA / COD model

| Phase | Behavior |
|-------|----------|
| **Level load** | Cook collision once (`addActor`) |
| **Seal (once)** | **One** `reinsertAll` + **one** `forceDynamicTreeRebuild(static)` + freeze thrash |
| **Seal never again** | No second rebuild / reinsert-all at play or health |
| **Play** | Unmoved statics are never re-touched |
| **ROOT motion** | Actor global T+R only (entity-local cook) |
| **PART / movers** | Kinematic or fp-gated world-cook via `replaceStaticWithCook` |
| **Stream in (AOI)** | Single `addActor` (+ optional single remove+add for bounds) |
| **Stream out** | Remove that region only |
| **Health soft / MISS** | Log + single-entity repair; **never** reinsert-all / rebuild tree |

### Why one boot reinsert is required

World-baked multi-shape cooks put triangle meshes at correct **world bounds**
(`getWorldBounds` / near-log look solid) but PhysX scene-query AABBs can stay
stale after bulk `addActor`. Symptom:

```text
static=1100  missing≈0  walls near feet in log  ·  sweepFeetY=MISS  ·  walk-through
```

**Fix:** exactly one `reinsertAllStaticActorsForSceneQuery()` after boot cook,
then `sealStaticSceneQuery()` freezes further bulk reinsert.  
**Not a fix:** thrashing reinsert-all / `forceDynamicTreeRebuild` from health ticks
(softs plaza after ~1 min).

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
  sealStaticSceneQuery()  // reinsertAll once + forceDynamicTreeRebuild once + freeze
  collidersReady = true
world.start()
```

### Seal semantics

`PhysXWorld.sealStaticSceneQuery()` does the **one** boot SQ commit:

1. `reinsertAllStaticActorsForSceneQuery()` — ensure scene membership + SQ AABBs
2. **One** `forceDynamicTreeRebuild(true, false)` — bulk statics must enter query tree
3. `flushQueryUpdates` when available
4. Freeze: `allowStaticReinsert = false`, `staticSqSealed = true` (no second rebuild)
5. Disable zero-dt warm sim; ensure infinite ground; invalidate CCT cache

Scene is created with `staticStructure = eDYNAMIC_AABB_TREE` so late single adds stay queryable without thrash rebuilds.

**Forbidden after seal:** any further reinsert-all or forceDynamicTreeRebuild (WASM thrash softs plaza).

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
| `forceDynamicTreeRebuild` **after seal** / from health | Second+ rebuild thrash softs plaza WASM SQ |
| `reinsertAllStaticActorsForSceneQuery` **after seal** / from health | Thrash softs CCT after ~1 min |
| `rebuildStaticSceneQueryTree` as health/runtime fix | Same class of thrash |
| `clearGltfStaticActors` / `clearAllSceneStaticActors` on boot seal | Soft hole while recooking |
| `simulate(0)` / zero-dt warm after seal | Corrupts concurrent pose slides |
| Health soft → reinsert-all / tree rebuild | Treats MISS as thrash trigger |
| Dirty-all extract every frame / double full extract at seal | Thrash-shaped hitch at ~79% |
| Pose-fp exact match as cook-queue “synced” | Float noise → forever recook queue |
| Content labels (“plaza”, parcel ids) in PhysX | Policy is scene-agnostic |

**Allowed exceptions:**

- **Boot only:** one `reinsertAllStaticActorsForSceneQuery()` immediately before seal.
- Help-panel **manual recook** (`recookPhysicsColliders`) — intentional debug; uses hot-replace, not wipe-first.
- **PART** world-cook for entities whose hull fp changed (fp is the thrash guard).
- **Scale-drift** geom recook — bounded cooldown; geom fingerprint mismatch only.
- **Missing actor** discover — truly absent PhysX actor only.
- Late first cook: **single** actor remove+add in `addStatic` after seal.

---

## Symptom → cause → COD fix

| Symptom | Cause | Wrong fix | COD fix |
|---------|-------|-----------|---------|
| Walk-through; walls in near-log; static=1100 | SQ AABB never committed after bulk cook | Health reinsert-all thrash / force rebuild | One boot reinsertAll then freeze |
| Soft after ~1 min idle | Runtime reinsert/rebuild thrash | More rebuild | Seal freeze; single-entity only |
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

Boot-only (must stay gated by `allowStaticReinsert`):

- `PhysXWorld.reinsertAllStaticActorsForSceneQuery` — once before seal only

Runtime no-op (must not regain thrash bodies):

- `PhysXWorld.rebuildStaticSceneQueryTree` → CCT cache only

---

## QA checklist (plaza / COD)

- [ ] Log: `reinsert=N` with N ≈ static count, then `static SQ sealed — … rebuild=never`
- [ ] `sweepFeetY` at spawn **not** MISS while near-log shows walls
- [ ] No reinsert-all / rebuild spam after seal
- [ ] Walk Genesis Plaza + fishing / pond solids; no soft after 1–2 min idle
- [ ] Promote / demote neighbor: solids stay, no Missing-actors thrash
- [ ] Freecam free; no void unload
- [ ] FPS recovers to 30–60 after load hitch

---

## Implementation invariant (agents)

Before any PhysX static change, ask:

1. Does this touch unmoved statics after seal? → **No.**
2. Does this call `forceDynamicTreeRebuild`? → **No.**
3. Does this call reinsert-all outside boot seal? → **No.**
4. Is cook only for missing / geom-changed / PART fp-changed? → **Yes.**
5. Is MISS handled by log + single repair, not thrash? → **Yes.**

If a change makes plaza walk-through while actors still exist, **it is P0** — reverse or fix before shipping.
