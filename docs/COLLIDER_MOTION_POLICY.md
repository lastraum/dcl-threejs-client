# Collider motion policy (platform-wide)

**Status:** **v1.5.0** ROOT/PART shipped · **2026-08-09** MeshCollider parent→child ROOT expand + riding law landed on `dev-latest` (no release)  
**Engine:** PhysX (CCT player + scene solids)  
**Scope:** all scenes — no content labels, no asset-type branches  
**Last updated:** 2026-08-09  

**Riding the player on movers** is a separate law: [RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md)  
(pose sync here · single stand-actor Δ there · never sticky / snap / pull-down bandaids).  
**Plan + COD:** [PLAN_MESHCOLLIDER_PLATFORM_RIDING.md](./PLAN_MESHCOLLIDER_PLATFORM_RIDING.md) · [COD_BRAINROT_PLATFORM_FANOUT.md](./COD_BRAINROT_PLATFORM_FANOUT.md)

## Two motion sources only

```text
DEFAULT (boot)
  cook once — entity-local multi-shape / MeshCollider
  do not touch PhysX geometry until motion demands it

Transform dirty  →  ROOT follow
  sources: CRDT Transform, Tween, Billboard, system Transform writes
  expand dirty parents → collider-bearing descendants (MeshCollider child under bob parent)
  PhysX: actor global pose = entity T+R only
  cooked verts / shape locals unchanged  (true cook-once + move)

Animator / system part  →  PART follow
  sources: active AnimationMixer, system part marks
  expand to extracted collider owner (parent/child tree)
  PhysX write only when live hull world fingerprint **changes**
  (fixed hulls under looping clips → stable fp → no-op)

  PART model (platform — PhysX triangle mesh constraint):
    1. PART candidates = mixers with running/scheduled clips only
       (not residual weight after finish — that caused forever thrash)
    2. force-refresh shape localMatrix from mesh/bone matrixWorld
    3. gate on coarse hull mesh-world fp (toFixed 2 ≈ 1cm) — float noise no-ops
    4. world-cook every entity whose coarse fp changed (geometryCache:false)
    5. replaceStaticWithCook / addActor + CCT cache invalidate (never forceDynamicTreeRebuild)
    NO cook budget — coarse fp + running-clip gate are the thrash guards

else  →  no PhysX pose work
```

## Why PART is not “pose-only”

PhysX shape local pose is **position + quaternion only**. Child/bone hull motion
leaves residual scale and invalid relative transforms; `setLocalPose` + SQ bounds
do not keep CCT in lockstep with skinned/hinged panels.

| Path | Geometry | Motion |
|------|----------|--------|
| **ROOT** | entity-local cook once | actor T+R only |
| **PART** | world-cook when hull fp changes | exact world hulls for CCT |

ROOT is cook-once + move. PART is **cook-when-hull-moves** (fp-gated, budgeted).
That is the platform rule for any scene — not a one-off content fix.

## Not policy

- Content labels (“plaza”, “door”, “building”, parcel ids)
- “Might this move someday?” at extract
- World-recook every Animator frame for every active mixer (soft thrash)
- Separate PhysX branches named Tween / Billboard

## Extract (facts only)

- Has physics shapes?
- Geometry + fingerprint

No motion destiny at extract. Motion is runtime: Transform dirty | Animator part.

## Runtime sets

| Set | Built from | API |
|-----|------------|-----|
| `transformDirty` | Transform writers with colliders | `pushColliderRootPoses` |
| `animatorPart` | active mixer / system part + tree expand | `pushColliderPartPoses` → `applyPartColliderMotions` |

## Code entry points

- `SceneScriptSystem.snapshotPhysMotionSets()`
- `World.syncPlayerMotionFrame` / async Animator path — ROOT then PART
- `PhysXWorld.applyPartColliderMotions` — world hull cook on fp change (all of them)
- `PhysXWorld.applyStaticColliderPoseUpdates` — ROOT actor slides

## Forbidden

- Classifying entities forever-static at load
- Shape-local rewrite on Transform-only dirty
- Scene/asset name checks in PhysX paths
- Budget-capping PART cooks (skips movers; fp gate is enough)
- Full static SQ rebuild / reinsert-all after boot (see [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md))
- Sticky multi-frame riding Δ · residual feet snap · pull-down “if floating” (see [RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md))
- Treating only `20M+` GLTF ids as stand surfaces (MeshCollider raw ECS ids ride too)

## Static cook-once (COD)

Unmoved scene hulls: cook once via `addActor`, seal freezes thrash, **never**
`forceDynamicTreeRebuild`. Platform law: [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md).
