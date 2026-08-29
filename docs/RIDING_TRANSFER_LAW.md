# Riding transfer law (CCT + scene solids)

**Status:** platform law (Explorer parity) — **landed on `dev-latest` 2026-08-09** (implementation gap close; **no release cut**)  
**Scope:** all scenes — no content labels  
**Related:** [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) · [PLAN_MESHCOLLIDER_PLATFORM_RIDING.md](./PLAN_MESHCOLLIDER_PLATFORM_RIDING.md) · `src/physics/platformMotion.ts`

## Law (one paragraph)

The player capsule is a **kinematic CCT**. Scene walk surfaces that move must (1) **move their PhysX actors** to match scene transforms the same frame, and (2) **add exactly that actor’s world Δ once** to the capsule **before** `move()`, only when that actor is the CCT ground contact. No sticky memory of old Δ, no second vertical snap, no pull-down recovery, no multi-probe merge that can stack.

## Frame order

```text
1. CRDT / Tween / system Transform → scene graph
2. ROOT pose sync  (transform dirty + collider-bearing descendants)
3. PART pose sync  (Animator hull fp change → world-cook)
4. Riding Δ = f(standPhysActor only)   // single measurement this frame
5. capsule += Δ
6. CCT move() + gravity / stick
```

## Stand phys id map (all classes)

| Phys id | Meaning | ECS / ride key |
|---------|---------|----------------|
| `-1` | Infinite ground | no riding |
| raw ECS | MeshCollider / mesh root | that entity |
| `20_000_000 + ecs` | GltfContainer parent | ecs |
| `40_000_000 + …` | multi-shape child | decode → parent → ecs |
| `19_000_000 + …` | landscape | no ECS ride |

## Single Δ author

```text
preferred:
  snapshot actor global pose (stand) → ROOT/PART write → Δ = pose' − pose

if stand is PART-only this frame (no ROOT slide):
  Δ = walk-surface top' − top (one probe on stand actor only)

else:
  Δ = 0
```

**Forbidden:** sticky multi-frame Δ · mesh matrix + actor root + bounds + sticky merge · residual snap after transfer · post-move pull-down when floating · scene-name special cases.

## CCT edge (not riding)

Descending platform **head-crush** (`eCOLLISION_UP` while surface descends) may snap onto tread — that is collision response, not a second riding transfer.

## Retest (platform, not scene-named)

| Case | Pass |
|------|------|
| Parent Transform bob + child MeshCollider | feet track tread; no multi-meter loft |
| Tween Move floor | ride for duration; land clean |
| Static MeshCollider floor | no micro-transfer jitter |
| Infinite ground only | no riding |
| PART door / hinged hull | walk when open; no forever thrash |

## Related geometry / CCT law (same platform, not riding Δ)

| Rule | Why |
|------|-----|
| DCL **cylinder** → vertical capsule (shape local rot X→Y) or box if flat | PhysX capsule is X-axis; wrong orientation = wild hulls / launches |
| Capsule half-height = `H/2 − R` (caps excluded) | Double-counting caps over-tall colliders |
| CCT `nonWalkableMode = PREVENT_CLIMBING_AND_FORCE_SLIDING` | Sphere sides / steep faces are not ladders |
| CCT slopeLimit **50°** (`WALKABLE_NORMAL_Y = cos 50°`) | Docs 45°; Creator Hub stair ramps are ~47°. 45° + FORCE_SLIDING snaps jump-climbs back down the flight. Grounded-contact uses the same cosine. |
| **Grounded ⇔ walkable support under capsule** | `eCOLLISION_DOWN` alone is not enough — need walkable hit this move, under-column XZ, contact within step of feet. Else freefall + gravity (walk off elevated pad into lower floor). |

## Code

- Pose: `World.syncPlayerMotionFrame` → `pushColliderRootPoses` / `pushColliderPartPoses`
- Ride: `PhysXWorld` stand actor slide Δ → `applyPlatformVelocityTransfer` once
- Cylinder cook / CCT: `PhysXWorld.addStatic`, `spawnPlayer`
- Policy: this file + `COLLIDER_MOTION_POLICY.md`
