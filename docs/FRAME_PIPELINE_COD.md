# Frame pipeline — admit, lanes, peel, depth composite

**Status:** platform law (main-thread pendingDiff discipline)  
**Bar:** [AGENTS.md](./AGENTS.md) continuity · PhysX analogue [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md)  
**Related:** mesh scale, multi-scene, material path · architecture overview [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Last updated:** 2026-08-11  

> **Filename / “COD”:** historical focus prompt (AAA-quality bar), not a product mode. Prefer “frame pipeline” in new prose.  

---

## One-line law

> **`pendingDiff` holds only true content dirty work.**  
> Motion / Material(+primitive leaf) / Structure(Gltf) drain on a **fixed** frame pie.  
> Pointer edges **peel-only** (never fullDump, never catch-pass).  
> Depth composite is **material-mode law**, never scene-name forks.

---

## Admit seal (PhysX PART-fp analogue)

| Put | Drop when |
|-----|-----------|
| Material | Three applied fingerprint matches (`isMaterialPutSealed`) **and** leaf exists if MeshRenderer present |
| MeshRenderer | Leaf already exists (`isMeshRendererPutSealed`) |
| Transform | Always admit motion (never promotes by itself) |
| Delete | Always admit |

**Forbidden:** content-blind fold of every LWW accept; adaptive budget boosts to “clear” a storm that is mostly sealed re-puts.

---

## Lanes (fixed FRAME pie)

| Lane | Components | PE edge |
|------|------------|---------|
| Motion | Transform, Tween, Animator, Billboard, Visibility | yes (cap) |
| Material | Material; **primitive** MeshRenderer (no GltfContainer); missing-leaf first | yes |
| Structure | GltfContainer, MeshCollider, TextShape, Avatar*, Gltf MeshRenderer | **never** |

```text
syncRenderer / drain:
  Motion → missing primitive leaves → Material puts → Structure(Gltf) [!pointerEdge]
```

**Click markers / new planes** = ordinary `mesh-create` + `material-scalar`, not a glow heuristic queue.

---

## Pointer peel-only

```text
on deliver-done:
  single drainPendingDiffLanes({ pointerEdge: true })
  light tween/particle advance
  // NO full pendingDiff walk, catch-pass, glow sort, dual peels
```

Level-state miss: PlayerEntity PET + PPI; **never invent y=0 ground PE hits**.

---

## Mesh promote seal

- GPU instance → private only on **PE / Tween / ineligibility transition**
- Already-private leaf: Transform is matrix/TRS only — **no re-promote thrash**
- `ensurePointerMeshesReady`: promote only while still instanced

---

## Depth composite (platform)

Reference: [How to Fix Z-Fighting in Three.js](https://threejsroadmap.com/blog/how-to-fix-z-fighting-in-threejs) — raise near first; coplanar needs offset/order, not log-depth as a scene patch.

| Role | Recognition | Law |
|------|-------------|-----|
| Solid | OPAQUE / ALPHA_TEST | depthWrite true |
| Blend surface | ALPHA_BLEND (+ maps or solid) | depthWrite true; band `BLEND_SURFACE` |
| Marker glow | map-less high emissive ALPHA_BLEND | depthWrite false; band `MARKER_GLOW` |
| Small coplanar plates | MeshRenderer plane scale &lt; ~3.5 | polygonOffset (constants module) |
| Large cover planes | scale ≥ ~3.5 | **no** polygonOffset (avoids VC holes) |

Bands: `src/bridge/material/depthCompositeBands.ts`  
Camera near/far: `src/camera/cameraDepthPolicy.ts` (`CLIENT_CAMERA_NEAR`, far from world diagonal)

**Forbidden:** `alpha > 0.4` threshold as law; scene-name depth forks; log-depth / reverse-Z as one-world fix.

---

## Kill list (forever)

- Adaptive `backlogLaneCaps` / backlog-proportional `drainMs`  
- `clickVfxCatchPassesLeft` / multi-frame VFX catch-pass  
- `isPointerClickGlowMarker` as **drain priority**  
- Dual peels (`flushPointerClickVisualStructure` + full drain)  
- Structure lane peeling Material  
- Full pendingDiff dump on PE  
- Invented ground PE hits  
- Scene-name forks for peel or depth  
- Re-promote private MeshRenderer every Transform  

---

## Pass criteria (play)

| Metric | Target |
|--------|--------|
| Steady `pendingDiff` under fog/board load | ≪ 256 typical; not multi-k sealed re-puts |
| `admitDrop` (material flush log) | non-zero under AUTH_RES / recolor no-ops |
| FPS | recovers without budget boosts |
| `fullDump` | 0 on PE edges |
| Click disc | ≤ 2 frames after worker publishes MeshRenderer+Material |
| Level-state PE | still works |
| Coplanar blend + solid | no permanent ground punch-through; markers above covers |

---

## Critical files

| File | Role |
|------|------|
| `SceneScriptSystem.ts` | admit, lanes, drain, pointer peel |
| `ThreeBridge.ts` | seal APIs, promote-once, plane bias |
| `MaterialApplier.ts` / `pbrApply.ts` | transparency + marker depth |
| `depthCompositeBands.ts` | renderOrder bands |
| `cameraDepthPolicy.ts` | near/far policy |
| `World.ts` | fixed 18ms pie deadline |
