# Portable Experiences — COD / AAA dual-scene law

**Status:** platform law on `yoga-revamp` (1.8 track)  
**Bar:** [cod_prompt.md](./cod_prompt.md) (read every evaluation) · [AGENTS.md](./AGENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Phased build:** [SCENE_LAYERS_PLAN.md](./SCENE_LAYERS_PLAN.md)  
**Related:** [SCENE_UI_COD.md](./SCENE_UI_COD.md) · [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) · [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md) · [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md)  
**Last updated:** 2026-07-31  

---

## One-line law

> **A running portable experience is a second full scene worker** (same `SceneScriptSystem` / CRDT / bridges / tick class as primary) **with no parcel footprint.**  
> It **never** demotes genesis FocusOwner or parcel continuity. Locomotion / camera / pose merge via **claims** into **one PlayerHost** (priority primary 100 > pe 50 > secondary 10).  
> **UI:** same Yoga COD as primary — only the DOM root differs (`#pe-ui-root`).  
> **Freeze ≠ pin.** Free-flight requires explicit `poseDrive` + freeze → `layer_drive`. Load-gate pin is `host_pin` only. `disableAll` alone never pins and never enters `layer_drive`.

### Explicit exceptions only (everything else is required parity)

| # | Exception |
|---|-----------|
| 1 | **No parcel bounds** / no PE walk footprint |
| 2 | **Claim priority 50** (primary wins same channel) |
| 3 | **Platform enable gates** — consent / scene `featureToggles` / live cap |
| 4 | **AvatarModifierArea + CameraModeArea** — **primary-only** (PE must not hide avatars or force camera mode; unload PE never leaves hide stuck) |
| 5 | **Comms / multiplayer room** — PE scene-room is **Phase E required** (not optional README); until E ships, PE multiplayer RPCs **fail loud**, never silent-success |

Anything not listed is required host parity (AvatarAttach, signedFetch with PE scene identity, full restricted surface, media, colliders, UI, tick class).

---

## Naming (do not confuse)

| Term | Means |
|------|--------|
| **Portable experience (this doc)** | Smart-wearable / PE worker · `FocusPolicy = 'pe'` · `#pe-ui-root` |
| **PointerEvents “PE” in SCENE_UI_COD** | Ui* pointer components / lead-law for paint — **not** portable experiences |
| **Secondary** | Neighbor FocusOwner-muted worker — **never** PE |

---

## Architecture (not alternatives)

```text
                    ┌──────────────┐
   keyboard/pointer │  InputHub    │──► primary layer worker
                    │  (fan-out)   │──► pe:<id> layer workers
                    └──────────────┘──► secondary (no player claims)

   ┌─ SceneLayerRegistry ─────────────────────────────────────┐
   │  primary · pe:… · secondary:…                            │
   │  each: SceneScriptSystem + kind + priority + physOffset  │
   │  PE: full features · NO parcel bounds · media/UI on      │
   └──────────────────────┬───────────────────────────────────┘
                          │ continuous claims + discrete intents
                          ▼
                   ┌─────────────┐
                   │ PlayerHost  │  World + PlayerSystem façade
                   │ merge once  │  primary > pe > secondary
                   └──────┬──────┘
                          ▼
              ONE capsule · ONE lens · ONE network pose

   HostPoseMode:
     host_feet   — walk; host writes reserved Player/Camera to all layers
     host_pin    — load-gate / fall-reset pin (SpaceRunner) — claim/helper only
     layer_drive — winning layer owns Player/Camera Transform; host follows
```

### Layer table

| Layer | Scripts | UI root | Media | Parcel bounds | Player claims |
|-------|---------|---------|-------|---------------|---------------|
| **Primary** | full | `#scene-ui-root` | FocusOwner on | yes | yes (100) |
| **PE** | full | `#pe-ui-root` | on | **none** | yes (50) |
| **Secondary** | full (muted FO) | never shown | off | neighbor offset | **no** loc/cam/pose |
| **Tertiary** | off + LOD | none | off | resident | no |

---

## Feature parity law (double scene)

When a PE is **running**, it must have the **same class of host surface** as primary, except:

1. **No parcel footprint / walk bounds** — PE content is avatar-local / host origin (no scene boundaries).  
2. **Priority 50** — primary wins when both claim the same channel.  
3. **Consent + scene policy + live cap** — platform gates for enable (Explorer-like); once running, features are full-class.

| Surface | Required | Phase |
|---------|----------|-------|
| `SceneScriptSystem` + worker + CRDT | yes | exists |
| Full-rate `onUpdate` (same tick class as primary) | yes | C kills PE pump |
| InputHub fan-out | yes | exists |
| 3D pointer + PE UI pointer (foreign-root gate) | yes | exists |
| Scene UI Yoga COD under `#pe-ui-root` | yes | exists |
| VirtualCamera / MainCamera bind | yes — claim winner; **never** mirror PE VC ids onto primary | B |
| InputModifier → capsule via claims | yes | B |
| PhysicsCombined force / impulse + Lamport | yes | B |
| movePlayer / teleport / emote (arbiter) | yes | exists |
| Colliders namespaced + STATIC_COLLIDER_COD | yes | exists |
| Collider PART/ROOT motion class | yes | E |
| Audio / Video / Stream / Analysis | yes | exists |
| getPlayer / identity / realm | yes | exists |
| AvatarAttach (PE resolvers survive promote) | yes | E |
| Spatial audio player root on PE | yes | E |
| signedFetch with **PE scene identity** | yes | E |
| Restricted: NFT, clipboard, setCameraTransform, scene emote | yes | E |
| Multiplayer / scene-room for PE | yes (exception #5 until E: fail loud) | E |

---

## Pose ownership law (critical)

| Mode | When | Capsule | Reserved Transform inject |
|------|------|---------|---------------------------|
| `host_feet` | Normal walk | Host CCT | Host → all workers every frame |
| `host_pin` | Load-gate / fall-reset (SpaceRunner) | **Pin feet** | Host inject |
| `layer_drive` | PE free-flight / vehicle (`poseDrive` + freeze) | Host follows layer feet | **Skip** host stomp of PE-owned poses |

**Hard rules**

1. **`InputModifier.disableAll` alone does not imply `host_pin` and does not enter `layer_drive`.**  
2. **`layer_drive` only when** winning layer publishes an **explicit `poseDrive` claim** **and** a locomotion freeze claim.  
3. SpaceRunner map load pin = primary load-gate helper → **`host_pin`**.  
4. Mode-only freeze (walk+jog+run without disableAll) blocks locomo **without** pin; still escapeable.  
5. Never pin for colliders-ready or multi-scene thrash ([AGENTS.md](./AGENTS.md)).  
6. **Camera claim:** PE bound MainCamera **beats** unbound primary freecam.  
7. **`layer_drive` always follows layer PlayerEntity feet** (attach correctness); VC still drives lens when bound.  
8. Freecam yaw/pitch/dist remain durable player state across PE VC bind/unbind (MULTI_SCENE camera law).

---

## Claims law (continuous)

Collect once per frame from **registry layers** (secondary ignored for these):

| Claim | Source | Host applies |
|-------|--------|--------------|
| `locomotion` | `InputModifier` on layer PlayerEntity | freeze/clear capsule keys; **not** auto pin |
| `camera` | MainCamera VC bound on layer | active `VirtualCameraBridge` = winner |
| `poseDrive` | **explicit** free-flight / vehicle claim from layer | required for `layer_drive` (with freeze) |
| `force` / `impulse` | PhysicsCombined* | claim-shaped; Lamport across layers |
| discrete | movePlayer / teleport / emote | keep `PrivilegedIntentArbiter` |

**Merge:** higher `SCENE_WORKER_PRIORITY` wins; same priority → latest timestamp; among PE prefer freeze.  
**Multi-PE locomotion:** freeze wins over non-freeze; else higher priority / latest.

**Kill target:** `PeMainThreadMirror` becomes temporary adapter then **deleted**. After B: **forbid new `*ByPe*` / `PeMainThread*` APIs**.

---

## Claim / tick order (hard — not optional)

```text
1. All layer workers complete engine.update for the frame (or publish claim snapshots)
2. PlayerClaimMerger merges once
3. PlayerHost applies HostPoseMode + capsule + lens
4. ReservedEntitiesSync injects host→workers (skip PE-owned poses on layer_drive)
```

**Never** permanently apply claims **after** `PlayerSystem.update` (1-frame freeze lag is P0).  
C (unify tick) is **mandatory after B** freeze claims — not “prefer.”

---

## Tick law

1. PE scripts run **every frame** like primary (`peTickIntervalMs = 0`).  
2. Continuous engine update is **layer policy**, not a PE-only product (`runPeVehicleInputPump` is debt).  
3. Pointer residual must not starve full-focus PE systems (keys + `engine.update`).  
4. Secondary stays FocusOwner-muted; do not force secondary into PE product path.

---

## UI law (portable × SCENE_UI_COD)

1. Primary paints **only** `#scene-ui-root`; PE paints **only** `#pe-ui-root`.  
2. Same Yoga / dirty / park / open laws as [SCENE_UI_COD.md](./SCENE_UI_COD.md).  
3. `#pe-ui-root` stacks above scene UI; under-point ownership prefers PE.  
4. Foreign-root pointer: each PES injects only for its `uiRootId`.  
5. Dual auth pick registries — dispose clears **own** registry only; never remove a shared root still in use.  
6. **No** `forceSceneUiRepaint` wipe on PE enable (HUD flash).  
7. **Multi-PE UI:** if concurrent cap > 1, **one DOM root (or namespaced subtree) per PE id**. Shared `#pe-ui-root` dispose that clears siblings is **forbidden**. Cap=1 may share one root.  
8. InputHub: focus under `#pe-ui-root` does **not** block hub keys (primary ECS text fields / chat still block).

---

## Physics law (portable × STATIC_COLLIDER_COD)

1. PE colliders use **`pePhysOffset`** namespace (`PE_PHYS_BASE + index * stride`).  
2. Late PE cook = single addActor (+ optional remove+add); **never** reinsert-all / `forceDynamicTreeRebuild`.  
3. Empty dirty stream must **not** drop still-registered PE phys ids (`allRegisteredPhysIds`).  
4. Unload PE = invalidate **those** ids only.  
5. ROOT/PART motion policy same class as primary for PE graph when wired.

---

## Lifecycle law

1. **No auto-start** — discover → available; enable via consent YES or HUD (Explorer-like).  
2. Scene `featureToggles.portableExperiences`: enabled | hideUi | disabled (+ URL override).  
3. `disabled` → unload all PE; `hideUi` → UI off, worker may run.  
4. Disable PE = **full unload** (worker, meshes, UI, colliders) — not mute-only.  
5. `wantEnabled` survives `/goto` without re-prompt when policy allows.  
6. Concurrent cap: tier 1 (low/med) / 2 (high) — fail closed.  
7. Discovery today: smart wearables; explicit non-wearable PE list out of scope until productized.

---

## AvatarAttach / signedFetch / promote invariants

1. **AvatarAttach:** each running primary or PE layer may bind attach targets; **parcel promote/demote must not clear PE attach resolvers**; unload PE invalidates only that layer’s attaches.  
2. **signedFetch:** PE worker uses **that PE’s scene identity / permissions bag**, not the primary parcel context — one unified wire, no PE-only fetch fork.  
3. **Spatial audio root:** bind for PE the same class as primary (not secondary-muted).

---

## Explicit non-goals

| Non-goal | Why |
|----------|-----|
| PE becomes primary / demotes genesis | Breaks FocusOwner parcel continuity |
| Parcel bounds for PE | Product: no scene boundaries |
| Merge old PE WIP branches as product | Reimplement under this law on yoga |
| Dual Scene UI layout invent for PE | SCENE_UI_COD only |
| InputHub primary-only keys | Kills multi-PE + free-flight |
| Secondary wins locomotion/camera | Secondary is muted FocusOwner |
| Full client rewrite / new worker model | Keep slots + `SceneScriptSystem` |
| Expanding PE-named hacks | Route into claims / HostPoseMode |
| New `*ByPe*` / `PeMainThread*` APIs after Phase B | Forbidden — claims only |

---

## Current debt (yoga tip — not AAA yet)

| Debt | Notes |
|------|--------|
| `PeMainThreadMirror` | PE → primary IM/forces parasite |
| `runPeVehicleInputPump` | PE-only tick product; still pointer-session gated |
| Host always stomps reserved PE/Camera Transform | No `layer_drive` |
| `disableAll` → pin feet | Fights free-flight drones |
| PE collider pose slides noop | Dirty-once only |
| Incomplete PE wire surface | AvatarAttach, spatial audio, signedFetch, full restricted |
| No `SceneLayerRegistry` / claims / HostPoseMode | On plan only |
| Shared `#pe-ui-root` multi-PE | Dispose can nuke siblings |
| 1-frame claim lag | Mirror after `PlayerSystem.update` |

---

## Kill-list (after claims / modes land)

1. `PeMainThreadMirror` class + `World.applyPeMainThreadMirror`  
2. `isAvatarLocomotionFrozenByPe` on PlayerSystem paths  
3. PE-only body of `selectActiveVirtualCameraBridge`  
4. `runPeVehicleInputPump` / PE early-return play-frame fork  
5. “Any disableAll ⇒ pin” for free-flight  
6. Duplicate scene-owned motion flags once `HostPoseMode` covers them  
7. PE force-repaint / dual-layout invent (stay deleted)

**Keep:** PortableExperienceManager lifecycle · consent · policy · HUD · `#pe-ui-root` · phys offset · PrivilegedIntentArbiter · InputHub fan-out · SCENE_UI_COD PointerEvents lead law

---

## AAA smoke matrix (harsh critic)

| Scenario | Must pass |
|----------|-----------|
| Genesis road walk | no freeze thrash |
| Enable smart-wearable PE (consent) | worker + meshes + HUD |
| **Neurolink free-flight** WASD + PE VC | `HostPoseMode=layer_drive`; hub `pressed=W`; no `disableAll pinned` spam; drone moves |
| PE loading UI clears | no key-hammer |
| **PE HUD open** + primary walk | no flash thrash |
| Primary IM freeze (menu) | primary wins |
| Mode-only freeze (no disableAll) | blocks walk; escapeable; no pin |
| **SpaceRunner pin with PE enabled** | `host_pin` still; Gltf FINISHED clears freeze-watch; PE still ticking |
| **Plaza bounce** impulse | once (Lamport) |
| Two-PE: enable both then disable one | sibling UI/meshes/colliders intact |
| Promote neighbor with PE running | registry + policy; PE attach not dropped |
| PE media on muted secondary stand | PE A/V on; secondary still muted |
| PE signedFetch / restricted | succeeds or **fails loud** with PE scene context |
| Freecam after PE VC unbind | yaw/pitch/dist preserved |
| deadsurge / PE AvatarAttach wearable | attach follows avatar across promote |

**Oracles:** `[layers] registry…` · claim change logs · `HostPoseMode → …` · absence of continuous `disableAll pinned` during free-flight · non-empty hub `pressed=` while holding W in free-flight.

---

## Implementation order

See [SCENE_LAYERS_PLAN.md](./SCENE_LAYERS_PLAN.md):

```text
Docs (this + plan) → A registry → B claims → C unify tick → D HostPoseMode + kill-list → E parity bridges
```

**Ship rule:** each phase leaves genesis walk + one PE smoke green. **A–D green ≠ AAA** — Phase E required for full double-scene parity. COD bar: fan out, harsh critique, loop until Explorer-side AAA for the slice. No PE special-case regrowth.
