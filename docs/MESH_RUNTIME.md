# Mesh runtime — P0 frame law

> Scene-agnostic. No scene-bundle or asset edits required.  
> Complements [ARCHITECTURE_AND_TECH_DEBT.md](./ARCHITECTURE_AND_TECH_DEBT.md).

## Pipeline

```text
Content map (hashes)  →  prefetch bytes (IDB / workers)   [init OK, no Three graphs]
GltfContainer on ECS  →  scheduleBackgroundLoad (idle)  [parse max 1 at a time]
Template in AssetCache → clone + attach (≤1 / frame; large → idle)
Materials              → scalars now; textures via tickDeferredMaterials
Colliders              → cook at attach / boot drain (unchanged)
```

## Rules (hard)

1. **Never bulk-parse the content map** at init. Bytes only. (`?softPrime=1` is opt-in profiling only.)
2. **Never `await load()` / cold parse** on the rAF or `onAsyncFrame` path.
3. **Parse concurrency = 1** (`AssetCache` parse slot).
4. **Attach at most one GLB work unit per drain** outside hydration burst.
5. **Large templates** (≥ ~80k tris): serial idle queue (one clone at a time + multi-rAF yield) — **including hydration**. Never unbounded clone on the attach pass.
6. **Mass pending mesh**: sample + **group by content hash** only. One cold parse kick **per hash** (not per entity). Ready attach can batch that hash. No rarity / “characters first” ranking — ring sample order. Time-budgeted (~10ms).
7. **No distance / visibility streaming** in this layer — the scene decides what exists on ECS.
8. **GPU InstancedMesh** (`SceneGltfInstancer`): static same-hash GltfContainers (parcel tiles, props) share one InstancedMesh per leaf. Skinned / Animator entities still SkeletonUtils.clone. Future `GltfNodeModifiers` → promote instance to private clone (copy-on-write).

## What “success” looks like

- Loading UI / Sync / character select stays **interactive** (not multi-second freezes).
- Characters and props still appear (may hitch once per large model as idle parse/clone runs).
- Logs: `[Hydration] … no bulk parse`, `[assets] IDB warm — skip…` or trickle IDB prefetch.
- Debug HUD: `meshTris` tracks unique geometry; `submitTris` can be higher (shadows / passes).

## Non-goals

- Scene or GLB content changes  
- Distance-based world streaming  
- Guaranteeing zero hitch on multi-million-triangle menus without content LODs  

## Follow-up (after this revamp)

- **Edit-flight InputModifier / VC shim cleanup** — not mesh. Strip remaining client policy around MOVE CAMERA (`inputModifierLocomotionGuard`, clear-block hooks, freeze latch, flight reassert). Scene owns freeze/clear/WASD→VC; transport only. Tracked in [ARCHITECTURE_AND_TECH_DEBT.md](./ARCHITECTURE_AND_TECH_DEBT.md) §P0.
