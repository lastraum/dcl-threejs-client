# Collider motion policy (scene-agnostic)

**Status:** enforced on `dev-latest`  
**Engine:** PhysX (CCT player + scene solids)  
**Last updated:** 2026-07-24  

## Rule (two sources only)

```text
DEFAULT
  cook once (entity-local multi-shape / MeshCollider)
  do not touch PhysX geometry

Transform dirty  →  ROOT follow
  actor pose = entity world T+R
  shape locals / cooked verts stay fixed
  sources: CRDT Transform, Tween, Billboard, system lerp
  (anything that dirties Transform — not separate PhysX paths)

Animator         →  PART follow
  any active mixer is a PART *candidate*
  PhysX write only when _collider mesh/bone world fingerprint **changes**
  force-refresh shape locals from mesh/bone worlds
  cook once (entity-local multi-shape + baselines)
  move: actor T+R + relative shape pose (current * inv(baseline)) + SQ reinsert
  if missing baselines / world-baked → **one** entity-local recook, then pose forever
  never per-frame world-bake thrash

else             →  no PhysX pose work
```

## Not policy

- Content labels (“building”, “plaza”, “door asset”)
- “Could this move someday?” at extract
- Live world-re-bake of statics for motion (removed; caused soft toggle)
- Separate PhysX branches named Tween / Billboard

## Extract (facts only)

- Has physics shapes?
- Geometry fingerprints / entity-local cook

No motion destiny stored at extract.

## Runtime sets

| Set | Built from | PhysX API |
|-----|------------|-----------|
| `transformDirty` | Transform writers + entities with colliders | `pushColliderRootPoses` |
| `animatorPart` | Animator active mixer / part motion + tree expand to extract owner | `pushColliderPartPoses` (pose only) |

## Code entry points

- `SceneScriptSystem.getPhysMotionSets()`
- `World.syncPlayerMotionFrame` — ordered: transforms → bridges → root poses → part poses → platform Δ
- `PhysXWorld.applyStaticColliderPoseUpdates` (shape motion) / `updateKinematicMultiShapePose`
- SQ: `reinsertStaticActorForSceneQuery` after `setLocalPose` (static **and** kinematic)

## Forbidden

- `geometryCache: false` re-cook every Animator frame (live world-bake thrash)
- Multi-shape shape-local rewrite on Transform-only dirty
- Classifying entities as forever-static at load
