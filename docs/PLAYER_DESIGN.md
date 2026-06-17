# Player & Locomotion — Design Review (Phase 2)

> **Status:** Design only — not implemented. Review before coding.  
> **Physics:** **NVIDIA PhysX** (WASM), ported from `dcl-avatar-hyperfy/hyperfy` — **not Rapier**.

## Goals

1. Replace **OrbitControls** with a **DCL-like first-person walk** experience
2. Collide with scene **`MeshCollider` (`CL_PHYSICS`)** volumes we already sync
3. Respect **scene spawn**, **parcel bounds**, and **`RestrictedActions.movePlayerTo`**
4. Align with **Hyperfy** player physics so VRM worlds and this client share the same stack
5. Keep a path open for **multiplayer avatar sync** (Phase 5)

---

## Architecture

```
┌──────────────── Main thread ────────────────────────────────┐
│ SceneHost (camera + renderer)                                │
│ PlayerSystem ──► PhysX scene ◄── CollisionSystem (static)    │
│     │              PxCapsuleController                       │
│     └──► CrdtMirror.PlayerEntity + CameraEntity transforms   │
│              (renderer → scene worker, later)                  │
└───────────────────────────────────────────────────────────────┘
```

| Module | Role |
|--------|------|
| **`PlayerSystem`** | Input, capsule controller, camera rig (port from Hyperfy `PlayerLocal.js`) |
| **`CollisionSystem`** (existing) | Three.js collider meshes + raycast for `CL_POINTER` |
| **`PhysXWorld`** (new) | WASM PhysX: static scene colliders + character controller |
| **`SceneHost`** | Drop OrbitControls when player active; camera follows capsule |

**Reference implementation:** `dcl-avatar-hyperfy/hyperfy/src/core/`

| Hyperfy file | Port to ThreejsClient |
|--------------|------------------------|
| `loadPhysX.js` | `src/physics/loadPhysX.ts` |
| `systems/Physics.js` | `src/physics/PhysXWorld.ts` |
| `extras/geometryToPxMesh.js` | `src/physics/geometryToPxMesh.ts` |
| `entities/PlayerLocal.js` | `src/player/PlayerSystem.ts` |
| `nodes/Controller.js` | Capsule controller wrapper |

Scene script keeps running in the worker. Player motion is **client-side** for MVP (Explorer does the same for local locomotion). We optionally write **PlayerEntity / CameraEntity** transforms back through the mirror so scene systems that read player position keep working.

---

## Physics mapping (DCL → PhysX)

| DCL | PhysX |
|-----|-------|
| `MeshCollider` box | `PxBoxGeometry` static actor |
| `MeshCollider` sphere | `PxSphereGeometry` |
| `MeshCollider` cylinder | `PxCapsuleGeometry` (or convex) |
| `MeshCollider` plane | `PxPlaneGeometry` / thin box |
| `collisionMask & CL_PHYSICS` | Included in PhysX static colliders |
| `collisionMask & CL_POINTER` | **Not** in PhysX — stays in `CollisionSystem.raycast()` |
| Player body | **`PxCapsuleController`** (~0.3m radius, ~1.6m height — Hyperfy defaults) |
| Gravity | `20` effective units (Hyperfy `PlayerLocal`; tune to match DCL feel) |

**Dependency:** PhysX WASM bundle from Hyperfy (`physx-js-webidl.js` + binary). No Rapier.

**GLTF colliders:** Phase 2b — triangle mesh via `geometryToPxMesh` (Hyperfy pattern).

---

## Input & camera (MVP)

| Input | Action |
|-------|--------|
| Click canvas | `PointerLockControls` lock |
| WASD | Move on XZ relative to camera yaw |
| Space | Jump (if grounded) |
| Esc | Unlock pointer |

**Camera:** First-person child of capsule (eye height ~1.2–1.6m, match Hyperfy `DEFAULT_CAM_HEIGHT`). Third-person / cinematic deferred to Phase 3.

**Not in MVP:** emotes, run/walk toggle (`AvatarLocomotionSettings`), slope limits — add after basic walk works.

---

## Scene bounds

Clamp capsule inside union of scene **parcel AABBs** (from `ResolvedScene.parcels`, 16m grid, SW origin). Soft push-back at edges rather than hard teleport unless `movePlayerTo` fires.

---

## ECS / shim hooks

| API / component | MVP behavior |
|-----------------|--------------|
| **`RestrictedActions.movePlayerTo`** | Teleport capsule + camera; wire main ↔ worker via `postMessage` |
| **`PlayerEntity` transform** | Client-owned; optional CRDT write to mirror each frame |
| **`CameraEntity`** | Match active camera pose |
| **`PointerLock`** | Set lock when scene requests (Phase 2b) |
| **`AvatarLocomotionSettings`** | Phase 4 with avatar mesh |

---

## Implementation phases

### 2a — PhysX boot + static scene colliders
- Port `loadPhysX()` + minimal `PhysXWorld` init
- Push `MeshCollider` primitives from `CollisionSystem` → PhysX static actors
- Keep OrbitControls; validate colliders with debug (`?colliders=1`)

### 2b — Player capsule (Hyperfy `PlayerLocal`)
- `PxCapsuleController` + ground sweep
- PointerLock + WASD + jump
- Replace OrbitControls (keep `?orbit=1` fallback)

### 2c — Scene integration
- `movePlayerTo` main ↔ worker
- Sync player transform into mirror for scene logic
- Parcel bounds clamp

---

## Open questions

1. **Orbit fallback** — keep `?orbit=1` permanently for dev? *(Recommended: yes)*
2. **PlayerEntity CRDT back to scene** — every frame vs only on teleport?
3. **Jump** — include in MVP or walk-only first?
4. **Gravity constant** — match Hyperfy (20) vs DCL Explorer (~9.81)? Tune in QA.

---

## Files (planned)

```
src/
├── physics/
│   ├── loadPhysX.ts           # WASM loader (from Hyperfy)
│   ├── PhysXWorld.ts          # scene, cooking, step, static actors
│   └── geometryToPxMesh.ts    # MeshCollider / glTF → PxMesh
├── player/
│   ├── PlayerSystem.ts        # capsule + input (from PlayerLocal.js)
│   └── playerCapsule.ts       # dimensions + spawn
├── collision/CollisionSystem.ts  # CL_POINTER raycast + export shapes for PhysX
└── core/World.ts              # PlayerSystem.update() in frame loop
```

---

## Related docs

- [`AVATAR_DESIGN.md`](./AVATAR_DESIGN.md) — runtime DCL avatar + custom VRM
- [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) — Phase 2 / 4 summary
- [`INTEGRATION.md`](./INTEGRATION.md) — MeshCollider, PointerLock, AvatarLocomotionSettings
