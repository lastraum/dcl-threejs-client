# Portable Experiences (PX) — COD / AAA dual-scene law

**Status:** platform law on `yoga-revamp` (1.8 track)  
**Bar:** [cod_prompt.md](./cod_prompt.md) (read every evaluation) · [AGENTS.md](./AGENTS.md) · [ARCHITECTURE.md](./ARCHITECTURE.md)  
**Phased build:** [SCENE_LAYERS_PLAN.md](./SCENE_LAYERS_PLAN.md)  
**Related:** [SCENE_UI_COD.md](./SCENE_UI_COD.md) · [STATIC_COLLIDER_COD.md](./STATIC_COLLIDER_COD.md) · [MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md) · [COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md)  
**Last updated:** 2026-07-31  

---

## Naming (mandatory)

| Abbreviation | Means |
|--------------|--------|
| **PX** | **Portable experience** — this doc · smart wearable / second full scene worker · `FocusPolicy = 'pe'` · `#pe-ui-root` |
| **PE** | **PointerEvents** only (Ui* lead law in [SCENE_UI_COD.md](./SCENE_UI_COD.md)) — **never** portable experiences |
| **Secondary** | Neighbor FocusOwner-muted worker — **never** PX |

Code still uses historical identifiers (`pe`, `PortableExperience*`, `pe-ui-root`, `pePhysOffset`, `PeMainThreadMirror`). New **prose and laws** say **PX**. Prefer new symbols without `*ByPe*` / portable-`Pe*` names after claims land.

---

## One-line law

> **A running PX is a second full scene worker** (same `SceneScriptSystem` / CRDT / bridges / tick class as primary) **with no parcel footprint.**  
> It can do **everything a scene can** (UI, media, InputModifier, VirtualCamera, AvatarModifier, CameraMode, forces, attach, signedFetch, …) via the same host surface class.  
> It **never** demotes genesis parcel continuity (PX is not a promote/demote of the place). Locomotion / camera / pose / modifiers merge via **claims** into **one PlayerHost** (priority primary 100 > px 50 > secondary 10).  
> **UI:** same Yoga COD as primary — only the DOM root differs (`#pe-ui-root` today).  
> **Host owns WASD.** Scene code moves the player (`movePlayerTo`, force/impulse) → host capsule adopts → **rebroadcast** reserved poses to all workers. There is **no layer_drive**. Load-gate pin is `host_pin` only (SpaceRunner), not PX free-flight.

### Explicit exceptions only (everything else is required parity)

| # | Exception | Plain English |
|---|-----------|----------------|
| 1 | **No parcel bounds** | PX is not a plot of land — content is avatar-local / host origin, not “only on these parcels.” |
| 2 | **Claim priority 50** | If the **place** and the **PX** both claim the same channel (walk freeze, camera, hide, …), the **place wins**. When the place is silent, the PX fully owns that channel. |
| 3 | **Platform enable gates** | Consent / scene `featureToggles.portableExperiences` / concurrent live cap control **when** a PX starts — not which features it has once running. |
| 4 | **Comms / multiplayer room (until Phase E)** | Full PX scene-room is **Phase E required**. Until then, multiplayer RPCs for PX **fail loud** — never silent “success.” |

**Not an exception:** AvatarModifier, CameraMode, VirtualCamera, attach, media, signedFetch, restricted actions, colliders, UI — **same as a scene**, resolved by claims when both primary and PX write.

---

## Architecture (not alternatives)

```text
                    ┌──────────────┐
   keyboard/pointer │  InputHub    │──► primary layer worker
                    │  (fan-out)   │──► px:<id> layer workers  (code id pe:*)
                    └──────────────┘──► secondary (no player claims)

   ┌─ SceneLayerRegistry ─────────────────────────────────────┐
   │  primary · px:… · secondary:…                            │
   │  each: SceneScriptSystem + kind + priority + physOffset  │
   │  PX: full scene features · NO parcel bounds · media/UI on│
   └──────────────────────┬───────────────────────────────────┘
                          │ continuous claims + discrete intents
                          ▼
                   ┌─────────────┐
                   │ PlayerHost  │  World + PlayerSystem façade
                   │ merge once  │  primary 100 > px 50 > secondary 10
                   └──────┬──────┘
                          ▼
              ONE capsule · ONE lens · ONE network pose

   Host pose:
     host_feet — WASD + host inject Player/Camera to all workers every frame
     host_pin  — load-gate only (SpaceRunner); not PX free-flight
     Scene movePlayerTo / forces → host adopts → rebroadcast to all workers
```

### Layer table

| Layer | Scripts | UI root | Media | Parcel bounds | Player claims |
|-------|---------|---------|-------|---------------|---------------|
| **Primary** | full | `#scene-ui-root` | FocusOwner on | yes | yes (100) |
| **PX** | full | `#pe-ui-root` | on | **none** | yes (50) — **full feature set** |
| **Secondary** | full (muted FO) | never shown | off | neighbor offset | **no** player claims |
| **Tertiary** | off + LOD | none | off | resident | no |

---

## Feature parity law (double scene)

When a PX is **running**, it has the **same host surface as primary**, except the three permanent exceptions above (+ multiplayer until Phase E).

| Surface | Required | Phase |
|---------|----------|-------|
| `SceneScriptSystem` + worker + CRDT | yes | exists |
| Full-rate `onUpdate` (same tick class as primary) | yes | C kills PX-only pump |
| InputHub fan-out | yes | exists |
| 3D pointer + PX UI pointer (foreign-root gate) | yes | exists |
| Scene UI Yoga COD under `#pe-ui-root` | yes | exists |
| VirtualCamera / MainCamera bind | yes — claim winner; never mirror PX VC ids onto primary | B |
| InputModifier → capsule via claims | yes | B |
| **AvatarModifierArea** (hide, etc.) | yes — claims; primary wins if both | B |
| **CameraModeArea** (force FP/TP) | yes — claims; primary wins if both | B |
| PhysicsCombined force / impulse + Lamport | yes | B |
| movePlayer / teleport / emote (arbiter) | yes | exists |
| Colliders namespaced + STATIC_COLLIDER_COD | yes | exists |
| Collider PART/ROOT motion class | yes | E |
| Audio / Video / Stream / Analysis | yes | exists |
| getPlayer / identity / realm | yes | exists |
| AvatarAttach (PX resolvers survive promote) | yes | E |
| Spatial audio player root on PX | yes | E |
| signedFetch with **PX scene identity** | yes | E |
| Restricted: NFT, clipboard, setCameraTransform, scene emote | yes | E |
| Multiplayer / scene-room for PX | yes (exception #4 until E: fail loud) | E |

On unload PX: clear any AvatarModifier / CameraMode / freeze / attach that this PX claimed so primary is not left stuck.

---

## Pose ownership law (critical) — host-owned input

| Mode | When | Capsule | Workers |
|------|------|---------|---------|
| `host_feet` | Default | WASD moves CCT | Host injects Player/Camera every frame |
| `host_pin` | Load-gate only (SpaceRunner) | Pin feet | Host inject |
| **Scene-authored move** | `movePlayerTo` / force / impulse from any layer | Host adopts pose | **Rebroadcast** to all workers |

**Hard rules**

1. **WASD always host** — PX InputModifier does **not** freeze the capsule (keys still fan out to PX workers for systems).  
2. **Primary** InputModifier may still freeze walk (place menus / load-gate).  
3. **`disableAll` alone does not imply `host_pin`** — pin is load-gate helper only.  
4. When **scene code** moves the player (not input): host `movePlayerTo` / apply force → **`rebroadcastHostPosesToAllLayers`**.  
5. There is **no `layer_drive`** (old idea: PX owns feet / skip host inject — **rejected**).  
6. **Camera claim:** PX bound MainCamera **beats** unbound primary freecam.  
7. Freecam yaw/pitch/dist remain durable player state across PX VC bind/unbind.

---

## Claims law (continuous)

Collect once per frame from **registry layers** (secondary ignored for player claims):

| Claim | Source | Host applies |
|-------|--------|--------------|
| `locomotion` | **Primary** InputModifier only | freeze/clear host WASD when place freezes |
| `camera` | MainCamera VC bound on layer | active `VirtualCameraBridge` = winner |
| `force` / `impulse` | PhysicsCombined* (any layer) | scene-authored motion on capsule |
| discrete | movePlayer / teleport / emote | arbiter → host adopt → **rebroadcast** |

**Merge:** higher `SCENE_WORKER_PRIORITY` wins; same priority → latest timestamp; among PX prefer freeze.  
**Multi-PX locomotion:** freeze wins over non-freeze; else higher priority / latest.

**Kill target:** `PeMainThreadMirror` becomes temporary adapter then **deleted**. After B: **forbid new portable `*ByPe*` / `PeMainThread*` APIs** (use claims / PX naming).

---

## Exclusive host channels (one controller)

Some host resources can only be **active once**. Layers **claim**; host **assigns** a single owner each frame (priority primary 100 > px 50).

| Channel | One owner | Loser |
|---------|-----------|--------|
| **VirtualCamera lens** | Winning MainCamera bind | Unbound freecam / other layer VC idle |
| **movePlayer / teleport** | Arbiter winner that frame | Silent if primary already moved |
| **Force / impulse on capsule** | Highest priority / lamport claim | Not applied |
| **WASD / freecam** | **Always host** (not a claim) | — |
| **Scene UI pointer inject** | Root under click (`#pe-ui-root` vs `#scene-ui-root`) | Foreign root must not inject |

Virtual camera is the template: **not** “both drive the lens.” Same idea for any single-owner host effect.

## Claim / tick order (hard — not optional)

```text
1. All layer workers complete engine.update for the frame (or publish claim snapshots)
2. PlayerClaimMerger merges once
3. PlayerHost applies claims (camera owner, forces, primary freeze only)
4. Host injects reserved Player/Camera to **all** workers (scene-authored moves rebroadcast extra)
```

**Never** permanently apply claims **after** `PlayerSystem.update` (1-frame freeze lag is P0).

---

## Tick law

1. PX scripts run **every frame** like primary (`peTickIntervalMs = 0` in code).  
2. Continuous engine update is **layer policy**, not a PX-only product (`runPeVehicleInputPump` is debt).  
3. Pointer residual must not starve full-focus PX systems (keys + `engine.update`).  
4. Secondary stays FocusOwner-muted; do not force secondary into PX product path.

---

## UI law (PX × SCENE_UI_COD)

1. Primary paints **only** `#scene-ui-root`; PX paints **only** `#pe-ui-root` (code id).  
2. Same Yoga / dirty / park / open laws as [SCENE_UI_COD.md](./SCENE_UI_COD.md).  
3. `#pe-ui-root` stacks above scene UI; under-point ownership prefers PX.  
4. Foreign-root pointer: each PES injects only for its `uiRootId`.  
5. Dual auth pick registries — dispose clears **own** registry only; never remove a shared root still in use.  
6. **No** `forceSceneUiRepaint` wipe on PX enable (HUD flash).  
7. **Multi-PX UI:** if concurrent cap > 1, **one DOM root (or namespaced subtree) per PX id**. Shared root dispose that clears siblings is **forbidden**. Cap=1 may share one root.  
8. InputHub: focus under `#pe-ui-root` does **not** block hub keys (primary ECS text fields / chat still block).

---

## Physics law (PX × STATIC_COLLIDER_COD)

1. PX colliders use **`pePhysOffset`** namespace (`PE_PHYS_BASE + index * stride` in code).  
2. Late PX cook = single addActor (+ optional remove+add); **never** reinsert-all / `forceDynamicTreeRebuild`.  
3. Empty dirty stream must **not** drop still-registered PX phys ids (`allRegisteredPhysIds`).  
4. Unload PX = invalidate **those** ids only.  
5. ROOT/PART motion policy same class as primary for PX graph when wired.

---

## Lifecycle law

1. **No auto-start** — discover → available; enable via consent YES or HUD (Explorer-like).  
2. Scene `featureToggles.portableExperiences`: enabled | hideUi | disabled (+ URL override).  
3. `disabled` → unload all PX; `hideUi` → UI off, worker may run.  
4. Disable PX = **full unload** (worker, meshes, UI, colliders, claimed modifiers) — not mute-only.  
5. `wantEnabled` survives `/goto` without re-prompt when policy allows.  
6. Concurrent cap: tier 1 (low/med) / 2 (high) — fail closed.  
7. Discovery today: smart wearables; explicit non-wearable PX list out of scope until productized.

---

## AvatarAttach / signedFetch / promote invariants

1. **AvatarAttach:** each running primary or PX layer may bind attach targets; **parcel promote/demote must not clear PX attach resolvers**; unload PX invalidates only that layer’s attaches.  
2. **signedFetch:** PX worker uses **that PX’s scene identity / permissions bag**, not the primary parcel context — one unified wire.  
3. **Spatial audio root:** bind for PX the same class as primary (not secondary-muted).

---

## Explicit non-goals

| Non-goal | Why |
|----------|-----|
| PX becomes primary / demotes genesis place | Breaks parcel FocusOwner continuity |
| Parcel bounds for PX | Product: no scene boundaries |
| Merge old PX WIP branches as product | Reimplement under this law on yoga |
| Dual Scene UI layout invent for PX | SCENE_UI_COD only |
| InputHub primary-only keys | Kills multi-PX + free-flight |
| Secondary wins player claims | Secondary is muted FocusOwner |
| Full client rewrite / new worker model | Keep slots + `SceneScriptSystem` |
| Expanding portable-only hacks | Route into claims / HostPoseMode |
| New `*ByPe*` / `PeMainThread*` APIs after Phase B | Forbidden — claims only |
| Restricting PX below scene feature set | **Forbidden** — only the exception table applies |

---

## Current debt (yoga tip — not AAA yet)

| Debt | Notes |
|------|--------|
| `PeMainThreadMirror` | PX → primary IM/forces parasite |
| `runPeVehicleInputPump` | PX-only tick product; still pointer-session gated |
| Host always stomps reserved Player/Camera Transform | No `layer_drive` |
| `disableAll` → pin feet | Fights free-flight drones |
| PX collider pose slides noop | Dirty-once only |
| Incomplete PX wire surface | AvatarAttach, spatial audio, signedFetch, full restricted, AvatarModifier/CameraMode claims |
| No `SceneLayerRegistry` / claims / HostPoseMode | On plan only |
| Shared `#pe-ui-root` multi-PX | Dispose can nuke siblings |
| 1-frame claim lag | Mirror after `PlayerSystem.update` |

---

## Kill-list (after claims / modes land)

1. `PeMainThreadMirror` class + `World.applyPeMainThreadMirror`  
2. `isAvatarLocomotionFrozenByPe` on PlayerSystem paths  
3. PX-only body of `selectActiveVirtualCameraBridge`  
4. `runPeVehicleInputPump` / PX early-return play-frame fork  
5. “Any disableAll ⇒ pin” for free-flight  
6. Duplicate scene-owned motion flags once `HostPoseMode` covers them  
7. PX force-repaint / dual-layout invent (stay deleted)  
8. Any “primary-only” gate that strips PX of scene features (AvatarModifier/CameraMode included)

**Keep:** PortableExperienceManager lifecycle · consent · policy · HUD · `#pe-ui-root` · phys offset · PrivilegedIntentArbiter · InputHub fan-out · SCENE_UI_COD **PointerEvents** lead law

---

## AAA smoke matrix (harsh critic)

| Scenario | Must pass |
|----------|-----------|
| Genesis road walk | no freeze thrash |
| Enable smart-wearable PX (consent) | worker + meshes + HUD |
| **Neurolink free-flight** WASD + PX VC | `HostPoseMode=layer_drive`; hub `pressed=W`; no `disableAll pinned` spam; drone moves |
| PX loading UI clears | no key-hammer |
| **PX HUD open** + primary walk | no flash thrash |
| Primary IM freeze (menu) | primary wins |
| Mode-only freeze (no disableAll) | blocks walk; escapeable; no pin |
| **SpaceRunner pin with PX enabled** | `host_pin` still; Gltf FINISHED clears freeze-watch; PX still ticking |
| **Plaza bounce** impulse | once (Lamport) |
| Two PX: enable both then disable one | sibling UI/meshes/colliders intact |
| Promote neighbor with PX running | registry + policy; PX attach not dropped |
| PX media on muted secondary stand | PX A/V on; secondary still muted |
| PX AvatarModifier / CameraModeArea | works when primary silent; primary wins if both; clears on PX unload |
| PX signedFetch / restricted | succeeds or **fails loud** with PX scene context |
| Freecam after PX VC unbind | yaw/pitch/dist preserved |
| deadsurge / PX AvatarAttach wearable | attach follows avatar across promote |

**Oracles:** `[layers] registry…` · claim change logs · `HostPoseMode → …` · absence of continuous `disableAll pinned` during free-flight · non-empty hub `pressed=` while holding W in free-flight.

---

## Implementation order

See [SCENE_LAYERS_PLAN.md](./SCENE_LAYERS_PLAN.md):

```text
Docs (this + plan) → A registry → B claims → C unify tick → D HostPoseMode + kill-list → E parity bridges
```

**Ship rule:** each phase leaves genesis walk + one PX smoke green. **A–D green ≠ AAA** — Phase E required for full double-scene parity. COD bar: fan out, harsh critique, loop until Explorer-side AAA for the slice. No PX special-case regrowth that strips scene features.
