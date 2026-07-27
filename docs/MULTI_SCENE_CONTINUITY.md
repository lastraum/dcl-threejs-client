# Multi-scene continuity (FocusOwner + sticky residents)

**Branch:** `feat/aoi-focus-owner`  
**Status:** in progress — continuity path landed; FPS / dual-worker budget still hardening  
**Last updated:** 2026-07-26  
**Bar:** COD-style walk continuity — no void unload, no freecam snap, no soft-route warp, 30–60 FPS target  

Quick rules for agents: [AGENTS.md § Multi-scene continuity](./AGENTS.md#multi-scene-continuity-non-negotiable).

---

## Product model

```text
PRIMARY (feet)
  FocusOwner — UI, media, privileged input, locomotion modifiers, AvatarModifier/CameraMode
  Full scene worker + scripts

SECONDARY (live ring / sticky demote)
  Same loaded graph — scripts every frame, FocusOwner MUTE
  Hard-capped (≤3 live secondaries) + serial boot concurrency (1)
  Live eligibility = scene-to-scene footprint proximity (16m), not player frustum alone

TERTIARY (resident)
  Same loaded graph — scripts OFF + visual LOD (no cast shadows / local lights)
  Triggered only by: leave live ring OR secondary-cap pressure
  Meshes + colliders stay — re-enter ring = scripts on only (no GLB reload)

COMPOSITE / AOI shells
  Roads, default ground, first-frame shells — no scene worker
  Procedural scatter trees/rocks ONLY on true vacant land (never real/resident footprints)
```

**Never** unload a scene into the void just because the player stepped onto a neighbor parcel.

---

## Promote / demote contract

### Stand-on-parcel promote

1. Prefer **live secondary handoff** (`takeForPromote`) — adopt existing `SceneScriptSystem`, no World rebuild.
2. If not warm yet: force-boot under-feet secondary, then handoff. **No** `disposeSecondariesOnly` + seamless jump for this path.
3. Demote prior primary → **sticky secondary** (always secondary mode on demote — parcel count is irrelevant).
4. Rebind host origin to the **new** primary SW **before** feet restore.

### Critical order (void / warp bugs)

| Step | Why |
|------|-----|
| `comms.bindSceneTarget(newPrimary)` before `restoreGenesisFeet` | Missing this leaves feet in old local space under new base → soft-route warp (e.g. -141,99 → -135,107) and “CBD unloaded” look |
| Demote before dispose thinking | Prior primary mesh root stays parented on host with secondary origin offset |
| Invalidate secondary-offset phys ids, then keep remapped sticky colliders | Plaza walk stays solid after demote |
| `setReadComponents` / InputHub / AvatarModifier to **new** primary only | Walk-back freeze / “became a vending machine” |
| Freecam is durable player state | Never reseed yaw/pitch/dist from scene VC on handoff |

### Sticky demote

- Graph + worker stay resident (`SecondaryLiveManager.adoptDemotedPrimary`).
- Mode on demote: **always secondary** (muted scripts).
- Tertiary only later via reconcile (leave 16m ring or cap).
- Colliders: capture remapped descs under `physOffset`, one-shot PhysX register (`forceRecookOnPoseChange: false`), mark synced.

### Promote settle window (~8s)

- `setSecondaryActivityEnabled(false)` — no neighbor cold boots during hydrate.
- `forceAllResidentsTertiary` — temporary scripts-off on residents so **new primary hydrates alone**.
- After settle: re-enable secondary activity; ring/cap reconcile decides secondary vs tertiary again.

---

## Budget (not parcel size)

| Lever | Policy |
|-------|--------|
| **Parcel count** | **Never** refuses secondary boot or picks tertiary. |
| Live radius | Scene-to-scene edge distance ≤ 16m (`SECONDARY_LIVE_SCENE_PROXIMITY_M`) |
| Live secondary cap | Hard ≤3 (`AOI_LIVE_SECONDARY_HARD_CAP`) |
| Boot concurrency | 1 at a time (`SECONDARY_LIVE_BOOT_CONCURRENCY`) |
| Tertiary residents | Cap 8; dispose farthest **non-sticky** only |
| Sticky demoted | Never auto-evicted |

---

## FocusOwner surfaces

| Surface | Primary | Secondary / demoted |
|---------|---------|---------------------|
| Scene UI / video / audio | on | muted |
| InputHub privileged | primary subscriber | none |
| InputModifier / freeze | primary only | never apply player-frame |
| AvatarModifierArea hide | primary only | demote clears hide |
| CameraModeArea force | primary only | demote clears force |
| VirtualCamera | drives lens only while `isActive()` | not freecam orbit owner |
| Freecam yaw/pitch/dist | durable on player across promote | handoff snaps boom to feet only |

`disableAllHoldFeet` arms **only** for intentional `InputModifier.disableAll` — never for colliders-ready thrash.

---

## Colliders across demote / promote

### Keep sticky solid (no plaza void)

1. On demote: `syncCollisionForce` once → `captureRemappedColliders` (entity + `physOffset`).
2. World invalidates **native primary** phys ids, then `syncStaticColliders(remapped, { forceRecookOnPoseChange: false, geometryCache: true, freezeRemoval: true })`.
3. `markResidentCollidersSynced` — stop streaming every frame.

### Dirty-once tertiary

Tertiary `tickAsync` returns remapped descs **only when `collidersDirty`**. Returning hundreds of descs every frame with freezeRemoval still active was a 2–3 FPS path.

### Do not wipe when empty this frame

`MultiSceneRuntime.tickAsync` must treat resident ids as still live via `allRegisteredPhysIds()` even when the dirty-once stream returns `[]`.

**Bug that caused CBD→scene→CBD 3 FPS:** empty stream ⇒ “not in this frame’s list” ⇒ invalidate every sticky id every frame ⇒ Missing actors ⇒ recook death spiral.

### Geometry fingerprints

Remapped descs keep the **original** geometry fingerprint so PhysX `geometryCache` can reuse cooks across primary↔secondary entity-id remaps. Prefixing `ms:…` forced full plaza recooks on every handoff.

### Promote primary re-register

After adopting sticky → primary: invalidate secondary-offset actors, extract under native entity ids, bounded force-sync (`cookBudget` capped, no force recook). One-time hitch possible; continuous thrash is a bug.

---

## AOI / ground continuity

| Rule | Detail |
|------|--------|
| Resident parcels | `residentParcelKeys()` registered with AOI — never empty-land or scatter under sticky demoted plaza |
| Default ground | Default parcel GLB on **all** non-road AOI parcels |
| Scatter (trees/rocks) | Only true vacant / catalyst-empty — never real scene footprints or residents |
| Retarget | `retargetPrimary` must not wipe tertiary/sticky meshes |

---

## Key code map

| Area | Path |
|------|------|
| Caps / product budgets | `src/dcl/multiScene/caps.ts` |
| World handoff | `World.applyPromoteHandoff` |
| Sticky demote / reconcile | `SecondaryLiveManager` |
| Resident modes + colliders | `SceneWorkerSlot` |
| Multi tick + phys id tracking | `MultiSceneRuntime.tickAsync` |
| Secondary root offset | `secondarySceneOrigin.ts` |
| Promote controller / soft route | `ScenePromoteController`, `AppController.promotePrimary` |
| AOI visuals / scatter ban | `AoiVisualLayer` |
| Freecam durable state | `PlayerSystem` (`notifySceneFocusHandoff`) |
| Focus mute | `SceneScriptSystem` focus policy + player-frame skip |

---

## Bugs fixed on this branch (continuity arc)

| Symptom | Cause | Fix direction |
|---------|--------|----------------|
| Void / unload on neighbor step | Seamless jump + dispose secondaries | Handoff + sticky demote only |
| Soft-route warp / empty CBD look | Origin not rebound before feet restore | `bindSceneTarget` first |
| CBD looks empty after return | Scatter/empty-land on resident parcels | Resident parcel keys + no scatter on real footprints |
| Freecam snap on promote | VC / timer reseed of orbit | Durable freecam + handoff snap boom only |
| Became vending machine / frozen walk | Demoted AvatarModifier + wrong MirrorComponents | Primary-only modifiers; rebind reads |
| No colliders after demote | Native ids wiped, remapped never kept | Capture remapped + one-shot PhysX keep |
| 3 FPS after keep-colliders | Dirty-once empty ⇒ invalidate all sticky ids every frame | Track `allRegisteredPhysIds`; markSynced |
| Dual freeze on promote | New primary + full sticky scripts | Settle: activity off + force residents tertiary temporarily |
| Sky GLBs after demote | Tertiary matrix freeze | Never freeze TRS on tertiary |
| Tertiary forced by parcel size | Size gate on demote / cold boot | Removed entirely |

---

## Manual QA checklist

- [ ] CBD → nested hole scene → CBD (quick walk): no void, colliders solid, freecam free
- [ ] Soft URL / minimap parcel tracks feet after promote (no -135,107-style warp)
- [ ] Sticky demote log is **secondary** (not size-based tertiary)
- [ ] After settle, leave live ring → tertiary (scripts off); re-enter → secondary (no GLB reload)
- [ ] FPS recovers after handoff hitch; no continuous Missing-actors / recook spam
- [ ] No procedural trees on CBD / resident footprints
- [ ] Avatar not permanently hidden after demote (AvatarModifier clear)
- [ ] `?noaoi=1` still primary-only debug path

---

## Primary load solids (Genesis Plaza)

Cold plaza load cooks hundreds of multi-shape actors. Full law:
[STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md). Order (COD):

```text
loadScene (worker onStart — scene systems)
waitForSceneAssets (attach GLBs)
prewarmPhysicsColliders (extract + progressive cook — does NOT seal)
spawnLocalPlayer:
  waitForColliderGraphSettle (pendingMesh→0)
  extract once (final matrices)
  cook missing only — never wipe all actors
  integrity drain
  reinsertAllStaticActorsForSceneQuery()  // ONCE — SQ AABB commit (world-bake)
  sealStaticSceneQuery (freeze reinsert; NEVER forceDynamicTreeRebuild)
  initCapsule
  collidersReady = true
world.start()
```

| Symptom | Cause |
|---------|--------|
| Soft at play with walls in probe | Graph settle early-exit (old: 4s + pending>0) → incomplete cook seal |
| Soft after "cook complete" wipe | `clearGltfStaticActors` + cache clear then recook partial extract |
| Bounds solid, CCT walk-through | Missing **one-shot** reinsertAll before seal; or zero-dt warm / forceDynamicTreeRebuild thrash |
| Soft after avatar load | Late GLB attaches never cooked before `collidersReady` |
| Soft after ~1 min idle | Runtime reinsert-all / rebuild thrash (must stay frozen after seal) |

Platform rules:

- **Never** `simulate(0)` / `computeInteractions(0)` to warm statics — only CCT cache invalidate.
- **Never** `forceDynamicTreeRebuild` (WASM SQ death).
- **Once** at boot: `reinsertAll` before seal so multi-shape SQ AABBs match (static=1100 + MISS without it).
- **Never** reinsert-all after seal / from health.
- Graph settle: wait `pendingMesh===0` (soft only at ≥97% attached + 2s stable).
- prepare: **cook missing only** — do not wipe all GLTF actors / geometry cache.
- `ensurePrimaryColliderIntegrity` after prepare + avatar + pre-walk before free walk.
- Log `[phys] integrity` / `prewarm cook` / `collider graph settle` / `reinsert=` / `static SQ sealed` on collision channel.

## Open follow-ups

- Dual full secondary scripts (e.g. plaza + neighbor both secondary) still expensive — budget is cap + radius, not parcel size; measure under real CBD ring load.
- Promote primary re-register can hitch once on huge plazas; geometry cache should blunt recook, not eliminate actor rebind cost.
- Long-term: reverse-map sticky colliders to primary entity ids without full extract when fingerprints match.
- Keep iterating until walk loops stay ≥30 FPS with solids and freecam intact.

---

## Scene multiplayer (fishing rods / syncEntity)

Genesis plaza fishing (and similar) uses `@dcl/sdk/network`:

| Piece | Requirement |
|-------|-------------|
| `isStateSyncronized()` | Becomes true after `RealmInfo.isConnectedSceneRoom` + REQ/RES CRDT (or solo timeout) |
| `syncEntity` | Needs `getUserData().userId` first (`Profile not initialized` if race) |
| Rods / lines | Network entities + `AvatarAttach` on local/remote skeletons |
| Cast interact | Usually **E** (`IA_PRIMARY`) or click (`IA_POINTER`) — **Space is `IA_JUMP` (8)**, not cast |

Host must:

1. Connect **scene** LiveKit room (not island-only).
2. Push `RealmInfo.isConnectedSceneRoom=true` to the worker after connect **and** at play-ready (`pulseSceneNetworkConnected`) so SDK `RealmInfo.onChange` fires REQ_CRDT_STATE.
3. Route `CommunicationsController.sendBinary` peerData to scene LiveKit (already default).

Debug: `?syncdebug=1` logs REQ/RES/CRDT on the sync channel.

## Related docs

- [AGENTS.md](./AGENTS.md) — non-negotiable rules for every change
- [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md) — PART vs ROOT PhysX motion
- [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) — cook-once statics · never full SQ rebuild
- [ARCHITECTURE.md](./ARCHITECTURE.md) — scene I/O model
- [PROGRESS.md](./PROGRESS.md) — milestone log
