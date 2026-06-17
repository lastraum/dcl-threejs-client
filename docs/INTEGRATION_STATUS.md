# Three.js Client — Integration Status Registry

> **Purpose:** Single community-facing checklist for what is implemented, partial, or not started.  
> **Machine-readable source:** `src/client/dev/integrationRegistry.ts` (ECS list also in `src/dcl/ecs/registry.ts`).  
> **In-app view:** Dev progress panel (`</>`) → **Integration status** tab.  
> **Task backlog:** [TASKS.yaml](./TASKS.yaml) — claim work via [CONTRIBUTING.md](../CONTRIBUTING.md).  
> **Testing:** [CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md) — deploy your own world (live immediately).  
> **Last updated:** 2026-06-17

---

## Status key

| Symbol | Meaning |
| ------ | ------- |
| ⬜ **none** | Not started |
| 🟡 **stub** | Scaffold / decode-only / placeholder |
| 🟡 **partial** | Works in some paths; gaps remain |
| 🟢 **render** | Implemented and used in production path |
| 🔵 **client-only** | Renderer writes or owns; scene cannot author via ECS API |

**Phase** numbers follow [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) (1 = scene boot, 3 = input/media, 4 = avatars, 5 = multiplayer, 6 = polish).

---

## Summary (2026-06-17)

| Area | Tracked | 🟢 Done | 🟡 Partial/stub | ⬜ Not started |
| ---- | ------- | ------- | --------------- | -------------- |
| ECS components | 65 | ~28 | ~5 | ~32 |
| Client UI & settings | 18 | 13 | 0 | 5 |
| Networking & social | 16 | 13 | 2 | 1 |
| Performance & rendering | 14 | 11 | 3 | 1 |
| ~system modules | 9 | 5 | 2 | 2 |

*Exact counts: run dev panel or count entries in `integrationRegistry.ts`.*

---

## 1. ECS components (all SDK7 components we track)

Full per-component tables with IDs and notes: **[ECS_COMPONENTS.md](./ECS_COMPONENTS.md)**.

Registry lists **every component** in `mirrorComponents.ts` / `CrdtProjection` — currently **65 entries** across:

| Category | Examples | Coverage |
| -------- | -------- | -------- |
| **core** | Transform, Tags, VisibilityComponent | 🟢 |
| **render** | GltfContainer, MeshRenderer, Material, LightSource, TextShape, Animator, Billboard | 🟢 |
| **physics** | MeshCollider, AvatarLocomotionSettings, InputModifier (read) | 🟢 / read |
| **input** | PointerEvents, Raycast, TriggerArea | PointerEvents 🟢 · Raycast/Trigger ⬜ |
| **media** | VideoPlayer, AudioSource, AudioStream | VideoPlayer 🟢 · Audio ⬜ |
| **motion** | Tween, TweenSequence, TweenState | 🟢 |
| **avatar** | AvatarShape, AvatarEmoteCommand | 🟢 |
| **ui** (in-scene) | UiTransform, UiText, … | ⬜ (HUD is separate — see §2) |
| **network** | NetworkEntity, NetworkParent | 🟡 projection decode only |
| **environment** | SkyboxTime | 🟢 |

**Not in registry:** unknown component IDs from future SDK versions — logged once and skipped (scene script still runs).

When adding ECS support: update **`src/dcl/ecs/registry.ts`** + **`mirrorComponents.ts`** + this doc section via **`integrationRegistry.ts`**.

---

## 2. Client UI & settings (browser HUD)

DOM overlay only — **not** in-scene `UiTransform` ECS.

| Feature | Status | Notes |
| ------- | ------ | ----- |
| Splash / login | 🟢 | Catalyst + wallet session |
| Loading screen + hydration timer | 🟢 | Count-up elapsed, attach stall timeout |
| Sidebar + responsive layout | 🟢 | `ClientUiLayout` CSS tokens |
| Scene chat panel | 🟢 | LiveKit RFC4, unread badge, teleport links |
| Emote wheel (B) | 🟢 | Profile + bundled emotes |
| Minimap | 🟢 | Scene parcels |
| World location card | 🟢 | |
| Debug panel (Help) | 🟢 | Position HUD, collider toggles, render quality |
| Dev progress panel | 🟢 | TASKS.yaml + this registry |
| Settings → Events (X) | 🟢 | DCL Events API |
| Settings → Map (M) | 🟢 | Genesis tiles, Jump In |
| Settings → Backpack (I) | 🟢 | Avatar preview, wearables |
| Settings → Graphics (P) | 🟢 | Light tier, shadows |
| Settings → Places / Communities / Gallery | ⬜ | Placeholder tabs |
| In-scene ECS UI | ⬜ | UiTransform stack — future |
| Voice / mic UI | ⬜ | LiveKit audio not in HUD yet |

Layout reference: [CLIENT_UI_LAYOUT.md](./CLIENT_UI_LAYOUT.md).

---

## 3. Networking & social

| System | Status | Notes |
| ------ | ------ | ----- |
| RFC4 movement in/out | 🟢 | Movement + MovementCompressed |
| RFC4 profile request/response | 🟢 | |
| RFC4 PlayerEmote + DLE chat fallback | 🟢 | Unity bundled emotes via chat text |
| RFC4 scene chat | 🟢 | `encodeRfc4ChatPacket` (companion path) |
| LiveKit scene / world / island rooms | 🟢 | |
| Remote avatars (load + lerp) | 🟢 | `RemoteAvatarManager` |
| RFC4 Scene binary packets | 🟢 | comms topic → scene script |
| SignedFetch (ADR-44) | 🟢 | Worker RPC |
| Catalyst content + wallet session | 🟢 | |
| Realm comms adapter discovery | 🟢 | |
| Archipelago adapter | 🟡 | Scaffold |
| ECS NetworkEntity sync | 🟡 | Projection decode + parent strip |
| Voice tracks (WebRTC) | ⬜ | Connected; no spatial voice UI |

Comms architecture rule: [.cursor/rules/comms-architecture.mdc](../.cursor/rules/comms-architecture.mdc).

---

## 4. Performance & rendering

| System | Status | Notes |
| ------ | ------ | ----- |
| CRDT projection + diff consumer | 🟢 | No second main-thread ECS engine |
| EntityStore (Phase 4) | 🟢 | Scene graph + remote avatars in store; mesh attach in ThreeBridge |
| PointerEvents cache | 🟢 | Genesis ~70–110 fps |
| LightManager culling + tiers | 🟢 | 40 m cull, 4/6/10 caps |
| GLTF hydration budgets | 🟢 | |
| Off-thread GLB parse pool | 🟢 | |
| AssetCache + IndexedDB | 🟢 | |
| Lazy PhysX WASM | 🟢 | |
| Collision prewarm gate | 🟢 | Before `world.start()` |
| GLTF Hyperfy colliders | 🟢 | Grouped actors, pose-only sync |
| Idle player physics skip | 🟢 | |
| GLTF InstancedMesh | ⬜ | Phase 6 re-arch |
| Shadow pass tuning | 🟡 | e10 deferred |
| Periodic full resync interval | 🟡 | Safety net; tune in e10 |

Re-arch context: [REARCHITECTURE_PLAN.md](./REARCHITECTURE_PLAN.md).

---

## 5. ~system modules (scene worker shim)

| Module | Status | Notes |
| ------ | ------ | ----- |
| `~system/EngineApi` | 🟢 | CRDT + sendBatch/subscribe (comms) |
| `~system/Runtime` | 🟢 | getSceneInformation, getRealm |
| `~system/RestrictedActions` | 🟡 | movePlayerTo, triggerEmote, openExternalUrl ✅ |
| `~system/CommunicationsController` | 🟢 | sendBinary, send (comms topic) |
| `~system/UserIdentity` | 🟢 | getUserData RPC |
| `~system/CommsApi` | 🟡 | topics ✅ · getActiveVideoStreams ⬜ |
| `~system/SignedFetch` | 🟢 | |
| `~system/EnvironmentApi` | ⬜ | |
| `~system/Testing` | ⬜ | Preview tests only |

---

## How to update (contributors)

1. Implement a feature — **test on your own world** when possible ([CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md)).
2. Update status in **`src/client/dev/integrationRegistry.ts`** (and **`src/dcl/ecs/registry.ts`** for ECS components).
3. Add or claim a task in **`docs/TASKS.yaml`**.
4. Refresh summary dates in this file when shipping a milestone.
5. `npm run prebuild` syncs TASKS fallback for offline dev panel.

---

## Related docs

| Doc | Role |
| --- | ---- |
| [CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md) | Deploy your own world for immediate testing |
| [ECS_COMPONENTS.md](./ECS_COMPONENTS.md) | Detailed ECS tables with component IDs |
| [TASKS.yaml](./TASKS.yaml) | Claimable backlog |
| [PROGRESS.md](./PROGRESS.md) | Milestone narrative |
| [AGENTS.md](./AGENTS.md) | AI / contributor onboarding |
| [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) | Phase roadmap |
