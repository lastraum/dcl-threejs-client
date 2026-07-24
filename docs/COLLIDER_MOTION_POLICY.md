# Collider motion policy (platform-wide)

**Status:** **v1.5.0 RC** — shipped on `dev-latest` (`e24ce7f`); ice rink + Genesis Plaza QA green  
**Engine:** PhysX (CCT player + scene solids)  
**Scope:** all scenes — no content labels, no asset-type branches  
**Last updated:** 2026-07-23  

## Two motion sources only

```text
DEFAULT (boot)
  cook once — entity-local multi-shape / MeshCollider
  do not touch PhysX geometry until motion demands it

Transform dirty  →  ROOT follow
  sources: CRDT Transform, Tween, Billboard, system Transform writes
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
    5. rebuild SQ
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
