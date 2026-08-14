# COD fan-out — brainrot.dcl.eth moving floors + launch/stuck

**Date:** 2026-08-08 · **resolved 2026-08-09**  
**Status:** ✅ **Parity gaps closed on `dev-latest` (no release)** — platform law landed; scene remains a repro only  
**Branch:** `feat/terrain-seed` → merge `dev-latest`  
**Bar:** AGENTS.md COD · scene-bundle-is-law · COLLIDER_MOTION_POLICY · RIDING_TRANSFER_LAW · AAA / Explorer parity  
**Agents:** explore (client platform motion) · explore (scene bundle) · explore (synthetic plane / spawn)  
**Implementation plan:** [PLAN_MESHCOLLIDER_PLATFORM_RIDING.md](./PLAN_MESHCOLLIDER_PLATFORM_RIDING.md) · **Law:** [RIDING_TRANSFER_LAW.md](./RIDING_TRANSFER_LAW.md)

---

## Platform law (one paragraph)

Moving walk surfaces are **scene Transform writes** (or Tween / Animator) that must (1) **slide PhysX actors** the same frame visuals move, and (2) **transfer Δ only for the CCT-grounded actor** into the kinematic capsule **before** `movePlayer`. MeshCollider phys ids are **raw ECS entity ids**; GLTF uses `20_000_000+ecs` (children may be `40_000_000+…`). Riding scope, stand-surface ECS mapping, and pose-sync must treat **all** phys id classes equally. Sticky multi-frame transfer must not re-inject stale **+Δy** after a bob apex. Synthetic PhysX y=0 ground and pointer `planeY0` are **not** riding surfaces and must not be blamed for elevated float.

---

## Scene law — `brainrot.dcl.eth` (bundle is truth)

**Entity:** `bafkreigsikpiemd72rft6o7j7kbwouewllqqjhvwdk5be3prehtqfyubja`  
**Entry:** `bin/index.js` `bafybeibhayjt5wiufzsrvdqvggbimv4347ylsayyf63tfnlhmhbnxvdydu`  
**Layout:** 3×3 base `0,0` (0–48 m), center **(24, \*, 24)**  
**Spawn:** x∈[3,6], **y=0**, z∈[3.25,6.25]

```text
WORLD (v3 → tP/rP/iP/aP/sP/cP/lP):
  Floor slab @ (24,-0.06,24) scale ~47×0.12×47  MeshCollider
  ~117 crazy-floor-tile PADS (grid step 4, skip r²<36 about center):
    parent Transform + custom "crazy-floor-tile" {baseY,phase,speed,amp}
    child box MeshCollider CL_PHYSICS scale (3.7, 0.18, 3.7)
    I3 every frame (main system VC):
      y = baseY + (0.5 + 0.5*sin(phase)) * amp
      baseY=0.05; amp≈0.12–1.25; speed≈0.6–2.8
      → pad TOP ≈ 0.05…1.4 m (NOT multi-story elevators)
  Walls ~5.5 m; corner pillars ~6.4 m
  PLAY: static cylinders (24,0.35) + (24,0.8) + green SPHERE MeshCollider
        (24,1.55) scale 1.35 — onPointerDown IA_POINTER "Play" maxDist 14 → zC()
  Ohio zone marker "STAND HERE 2x POINTS" teleports among cardinal pads (text only)

GAME (phase menu|playing|gameover):
  zC() on PLAY click — aura state, spawn targets, emote robot, music
  Good targets: visual bob y≤~0.33 — NO MeshCollider
  Fanum (bad): MeshCollider child CL_PHYSICS + XZ chase + small bob
  Skibidi toilet: orbit r=14 at y=0 with cylinder colliders
  NO movePlayerTo / teleport / PE impulse / AvatarModifier launch on player
  Contact scoring is soft math on PlayerEntity.position (not physics forces)

composite: empty of game colliders — runtime script owns entities
```

**Scene does not author a 6–8 m launch.** Bundle never writes player velocity or teleport for PLAY / pads.

---

## User log map

| Signal | Meaning |
|--------|---------|
| feet y 0.3→0.6→0.9 | Normal pad / pedestal height band |
| **y 0.9→6.9→8.4 in ~1 s** | Multi-frame injection or wrong high solid — **not** single pad amp |
| `groundPhys=2331` @ y=6.86 | CCT grounded on **MeshCollider ECS 2331** (not GLTF `20M+`, not infinite `-1`) |
| `planeY0=null` | Pointer aim ray misses world y=0 (look up / horizon) — **not PhysX** |
| `groundPlane=y0` / infinite ground | Always-on CCT safety box; **not** stand surface when groundPhys=2331 |
| Glider PropertyBinding noise | Mid-air glider skin tracks; secondary after launch |
| `admitDrop` mesh-renderer flush | Material admit, not collision |

---

## Client pipeline (what we have)

```text
syncPlayerMotionFrame
  stand = resolveStandSurfacePhysEntity(lastGround)
  beginPlatformMotionFrame(stand)   // scope riding Δ
  consumeSyncFrameTransforms        // CRDT → matrix; mark descendant colliders dirty
  pumpMotionBridges
  snapshotPhysMotionSets → ROOT push / PART cook
  pose Δ probes → platformMotionDelta (scoped)
PlayerSystem
  applyPlatformVelocityTransfer()   // capsule += Δ; optional snapFeet
  movePlayer(CCT) → lastGroundPhysEntity
```

| Piece | Status |
|-------|--------|
| Infinite y=0 box for CCT | Works; never removed; ignored for riding |
| ROOT slide for MeshCollider actors | Intended via `colliderPoseDirty` + `lastPoseChanged` |
| Descendant dirty when parent Transform moves | **Yes** `markDescendantColliderPosesDirty` |
| `transformDirty` includes parent-only bob roots | **No** — parent has no MeshCollider → `addRoot` skips |
| `standSurfaceEcsFromPhys(2331)` | **Broken** — only maps `phys ≥ 20_000_000` → **null** |
| `groundIsMoving` for MeshCollider stand | **False always** when groundPhys is raw ECS id |
| Sticky riding Δ | **12 frames**, refresh on every successful transfer |
| Per-frame \|Δy\| cap | 1.5 m — too soft under sticky multi-frame stacking |
| Pointer `planeY0` | Diagnostic only |

---

## Ranked findings

### WORKS

1. Scene loads world, MeshRenderer primitives, materials, TextShape, Billboard, PointerEvents on PLAY.  
2. Infinite ground prevents void fall; hard floor y&lt;0 clamp.  
3. Collider motion policy split ROOT vs PART is documented and partially wired.  
4. Parent Transform CRDT marks **descendant** MeshCollider pose dirty (path exists for pad children).  
5. Riding intentionally scoped to CCT ground actor (distant props should not move you).  
6. PLAY is click-to-start only (Explorer-correct PE path).

### LIKELY BROKEN (brainrot symptoms) — P0

| # | Issue | Evidence / anchor |
|---|--------|-------------------|
| ① | **`standSurfaceEcsFromPhys` ignores MeshCollider phys ids** → `groundEcs=null`, `groundIsMoving=false` for `groundPhys=2331` | `SceneScriptSystem.ts` ~1176–1178; `World.syncPlayerMotionFrame` ~2118–2168 |
| ② | **Sticky Δ 12f + refresh** can re-apply last rising **+Δy** after bob apex / hitch → multi-frame climb to ~6–8 m | `PhysXWorld.recordStickyPlatformDelta` ~2973–2982; transfer ~3206–3268 |
| ③ | **Transfer then `snapFeetToPlatformWalkSurface`** can double-lift; surface may be pivot / AABB **maxY** not tread | transfer ~3263–3267; snap ~3146–3157; `physxActorWalkSurfaceTop` uses bounds **maxY** |
| ④ | **Parent bob vs child MeshCollider** — `transformDirty` ROOT set does not expand hierarchy (PART does); riding relies on fragile poseSync/lastPoseChanged | `buildPhysMotionSets` ~998–1018 vs `expandToExtractedColliderEntities` only on PART |
| ⑤ | Large static **PLAY sphere** + pedestal + **~117 moving CL_PHYSICS pads** — any desync launches/sticks CCT; stuck high with groundPhys set = standing on a high hull, not vacuum | Bundle `cP` / `tP` / `I3` |

### GAPS for AAA / Explorer parity — P1–P2

| # | Gap | Priority |
|---|-----|----------|
| ⑥ | Multi-shape GLTF child phys ids (`40M+`) vs parent Δ keys / ECS decode | P0 for GLTF movers; secondary for brainrot MeshCollider |
| ⑦ | World-baked ROOT no-op while actor-root still records riding Δ | P0/P1 GLTF |
| ⑧ | Sticky lacks reverse-velocity / ground-entity-change cancel | P1 |
| ⑨ | Dead / unwired `applyGroundContactDelta` | P2 |
| ⑩ | Infinite ground always under sealed worlds (fall-through soft-lands at sea level) | P2 policy |
| ⑪ | `planeY0` logs easy to misread as PhysX | P2 log clarity |
| ⑫ | Fanum invisible physics boxes + skibidi orbiting colliders need same ROOT follow | P1 once pads fixed |

---

## Synthetic plane verdict

| Question | Answer |
|----------|--------|
| Did synthetic PhysX plane launch the avatar? | **No** — feet @ ~7 with `groundPhys=2331` |
| Did pointer `planeY0=null` cause stuck? | **No** — aim diagnostic only |
| Can plane fight elevators at y≈7? | **No sandwich**; only safety net under holes |

---

## Ranked actions (do not invent scene forces)

| # | Priority | Action | Risk |
|---|----------|--------|------|
| ① | **P0** | Map MeshCollider phys id ↔ ECS in `standSurfaceEcsFromPhys` / `groundIsMoving` / poseSync so **2331-class** stands drive actor-root + walk-surface Δ | Med |
| ② | **P0** | Expand **transformDirty ROOT** to collider-bearing descendants (mirror PART `expandToExtractedColliderEntities`) when parent Transform moves | Med |
| ③ | **P0** | Sticky riding: cancel on Δy sign flip, ground entity change, or unground; do not refresh full 12f on every transfer of same stale vector | Low–med |
| ④ | **P0** | Cap multi-frame vertical transfer budget (e.g. max climb per 250 ms) and re-validate surface under feet after transfer | Low |
| ⑤ | **P1** | Snap feet only to true walk tread (not actor AABB maxY / matrix pivot); skip snap if gap already closed by Δ | Med |
| ⑥ | **P1** | Retest brainrot with `?platformdebug` — prove transfer Δ series vs sticky | — |
| ⑦ | **P1** | PLAY sphere: ensure CCT does not treat large static sphere as “floor” for snap (layer / contact normal) | Med |
| ⑧ | **P2** | Log tag `aimDiag planeY0=` vs `phys groundPhys=` | Low |

**Invariant:** No scene-name fork (`if brainrot`). Fix MeshCollider parent-child movers **platform-wide**.

---

## Pass/fail retest contract

**Setup:** `brainrot.dcl.eth`, spawn, walk onto **moving floor tiles** (not center open circle), then toward PLAY. Enable `?platformdebug`.

**PASS:**

```text
Stand on bobbing pad → feet y tracks pad top (~0.1–1.4), no multi-meter spikes
platform transfer Δy ≈ pad dy/frame (≪ 0.1 @ 60fps), entity = MeshCollider child
groundPhys = small ECS id of pad collider (or stable)
Walk to PLAY pedestal → click green orb → game starts; no launch
Center open floor → stand at y≈0 on floor slab
No sticky re-apply after pad starts descending
```

**FAIL (client P0):**

```text
Feet y jumps ≥1.5 within 1–2 frames without PE impulse
Repeated platform transfer sticky with same +dy after pad phase decreases
groundPhys set at y>3 in center open zone (no pad tops that high)
groundIsMoving never true while standing on crazy-floor-tile child
```

---

## Related code / docs

- `src/physics/platformMotion.ts` — two pipelines  
- `src/physics/PhysXWorld.ts` — sticky, transfer, infinite ground, walk surface  
- `src/core/World.ts` — `syncPlayerMotionFrame`  
- `src/core/systems/SceneScriptSystem.ts` — motion sets, stand surface, descendant dirty  
- `src/player/PlayerSystem.ts` — transfer before CCT move  
- `docs/COLLIDER_MOTION_POLICY.md`, `docs/PHYSICS_PARITY_PLAN.md`  
- Bundle cache (session): `/tmp/brainrot-scene/bin-index.js`

---

## Kill-list (do not re-add)

- Scene-name forks for brainrot  
- Blaming / removing infinite ground as the launch “fix”  
- Inventing PE ground hits from `planeY0`  
- Per-scene impulse hacks instead of MeshCollider ROOT follow  
- Raising sticky lifetime / residual snap / pull-down to “help” elevators  
- Per-game nginx locations instead of `/api/scene-http`

---

## Resolution (2026-08-09)

| Gap | Fix (platform law) |
|-----|-------------------|
| MeshCollider stand map miss | `standSurfaceEcsFromPhys` raw ECS + `groundIsMoving` |
| Parent Transform without child actor slide | ROOT expand to collider-bearing descendants |
| Multi-meter loft / sticky ascent | Single stand-actor pose Δ; **delete** sticky / residual snap / pull-down |
| PLAY sphere climb / launch | Y-up cylinder cook + nonWalkable sliding |
| Walk off elevated pad → air hover | Grounded ⇔ walkable under capsule column |
| Leaderboard CORS | Generic `/api/scene-http/...` (not scene-named) |
| Clipped HUD text | TextShape content width (no invent 1 m) |
| Washed outdoor / neon chalk | toneMapped neon + bloom 0.92 + ambient/exposure |

**Retest pass (user-confirmed):** pads ride clean · center / walk-off no hover · PLAY PE works · text + color closer to Explorer.

## Bottom line

Brainrot’s “elevators” are **`crazy-floor-tile` parents** bobbing **~1.3 m** with **child MeshColliders**, plus a static **PLAY sphere**. The scene **does not** fling the player. Logs showed a **MeshCollider stand at illegal height** (`groundPhys=2331`, y≈7) from **client riding / sticky / stand-id mapping** failures — fixed by Explorer-parity platform law, not synthetic plane removal and not scene forks.
