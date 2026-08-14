# MeshRenderer scale (any scene)

> Goal: **Any scene may stamp ≥12 000 `MeshRenderer` planes** and stay interactive.  
> No scene-name special cases. Classification is **component + density** only.  
> Related: [OPTIMIZATIONS.md](./OPTIMIZATIONS.md) · plaza GLTF instancing is separate (`SceneGltfInstancer`).

---

## Principles

1. **ECS/CRDT is always authoritative** — Material color, Transform, Animator state apply when the put arrives (even if far / not sampled).
2. **Visual work is tiered** — instancing is opportunistic; private mesh is fine when required.
3. **Cost is O(dirty + active live set)**, not O(entity count).
4. **Far / budgeted animators do not lose state** — on become-near: snap from ECS + one pose sample; never drop Material/Transform puts.

---

## Tiers (auto)

| Tier | Eligibility (all must hold for T1) | Representation | Per-frame |
| ---- | ---------------------------------- | -------------- | --------- |
| **T0 Culled** | `visible=false` or far LOD (optional) | Slot hidden / no draw | ~0 |
| **T1 Instanced** | Same geo key + scalar (or palette) mat + static + (PE policy) | `InstancedMesh` bucket | Dirty matrix only |
| **T2 Pooled private** | Static; may differ in ways that block instance | Shared geo + pooled mat + **frozen** mesh | ~0 after freeze |
| **T3 Live private** | Tween / Billboard / Animator / AvatarAttach / animated UVs / unique tex | Private mesh | Dirty-only TRS / fair anim |

**Promote** out of T1→T2/T3 when disqualifying component is put.  
**Demote** to cheaper tier when disqualifiers clear (optional P1).

### T1 eligibility (P1+)

- Standard primitive; UVs default or **static** custom (key-stable)
- **Not** animated UV sprite / marquee
- Material scalar-only (color/alpha) **or** shared texture + instance color (P2)
- No Animator, AvatarAttach, GltfNodeModifiers
- Tween: only if TRS can be instance matrix (optional; else T3)
- Billboard → T3 (P0)
- PointerEvents: **P0** private if PE present; **P1** instance raycast → entity
- MeshCollider: visual can be T1/T2; collider mesh separate (shared geo already)

---

## Authority vs sampling (distance / fair anim)

| Always when CRDT arrives | May skip while far / over budget |
| ------------------------ | -------------------------------- |
| Material (color) | Mixer.advance every frame |
| Transform value (tween eval on worker) | Full skeleton / matrixWorld of static neighbors |
| Animator **state** (clip, playing, weight) | Continuous clip sampling |
| Visibility | Shadow cast for every tile |

**On become-near / become-live:**

1. Re-read ECS  
2. Apply Material / Transform / Visibility  
3. Animator: bind if needed, apply states, **seek** (end pose if finished; loop phase from clock/state), `mixer.update(0)` once  
4. Resume normal sampling  

Do **not** replay all missed frames with huge `dt`.

---

## Phases

### P0 — Universal foundation

| Item | Status |
| ---- | ------ |
| Shared **primitive geometry** pool by `primitiveMeshKey` (not for animated UV sprites) | **done** (`primitiveShapes.ts`) |
| Immediate **scalar Material** apply on put; queue if no visual yet | **done** (`ThreeBridge`) |
| **Freeze** static MeshRenderer roots; unfreeze on motion components | **done** |
| Cast policy: high = explicit only; ultra = SDK default; density-safe | **done** (`MaterialApplier`) |
| Deferred texture budget raised for recolor storms | **done** |
| UI text coalesce + log throttle | **done** |

**Goal:** 12k planes allowed; color flips same frame; static board CPU not O(12k matrix updates).

### P1 — Instancing + dirty motion

| Item | Status |
| ---- | ------ |
| MeshRenderer `InstancedMesh` buckets | **ON** (`MESH_RENDERER_GPU_INSTANCE=true`) — geo bucket + `instanceColor` only (no color rebucket) |
| Dirty instance matrix on Transform | **done** — matrix rewrite only; **no** promote-on-motion (GLTF-only) |
| PE → instance raycast | **done** only when PE entity is instanced |
| Fair Animator sample + snap-on-near | **done** (wake re-applies ECS / wall-clock) |
| Secondary multi-scene: do not unfreeze entire graph | **done** (`SceneWorkerSlot`) |

### P2 — AAA

| Item | Status |
| ---- | ------ |
| `instanceColor` recolor without rebucket | **done** (scalar MeshRenderer boards) |
| Material scalar pool helpers | **done** (`acquireScalarMaterial` available) |
| UI text-only paint path | **done** (`SceneUiBridge` layout-stable patch) |
| Far merge / max live MeshRenderers | deferred (optional density LOD later) |

### Pixelwars note

Two stacks in one scene:

1. **Paint cells** — `MeshRenderer.setPlane` + `Material.setPbrMaterial` (team `albedoColor`). Client: MeshRenderer GPU instance + `instanceColor`. Transform rare; flips = Material only.
2. **Track pieces** — `GltfContainer` `tile-*.glb` (no animations). Client: `SceneGltfInstancer` + colliders. Not the flip-color path (not GltfNodeModifiers for paint).

---

## Non-goals

- Scene-name switches (`pixelwars` only)
- Forbidding 12k MeshRenderers
- Mass `castShadow=true` on graphs
- Running 12k AnimationMixers at full rate

---

## Validation

| Check | Target |
| ----- | ------ |
| Dense board idle FPS | ≥ 45 floor, ≥ 55 target (medium/high) |
| Material recolor latency | ≤ 2 frames after put |
| castSh | ≪ mesh count on high; never ≈ meshes on boards |
| Far flip then walk up | Correct color without replaying flip |
| Plaza smoke | No regression on roads / PE / GLTF instance |

---

## Touchpoints

- `src/bridge/primitiveShapes.ts` — geometry pool  
- `src/bridge/ThreeBridge.ts` — attach, freeze, material path  
- `src/bridge/material/MaterialApplier.ts` — cast + scalars  
- `src/shim/worker/sceneEngineUiScheduler.ts` — UI coalesce  
- `src/client/ui/RenderStats.ts` — inventory  
