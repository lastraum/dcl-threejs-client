# Three.js Client — Integration & ECS Status

> **Purpose:** Single checklist for ECS components, client UI, networking, and performance.  
> **Machine-readable:** `src/dcl/ecs/registry.ts` + `src/client/dev/integrationRegistry.ts`  
> **In-app:** Dev panel (`</>`) → **Integration status** tab  
> **Milestone log:** [PROGRESS.md](./PROGRESS.md) (also loaded live from GitHub in dev panel)  
> **Community claims:** [CLAIMS.yaml](./CLAIMS.yaml) (synced from GitHub `in-progress` issues)
> **Last updated:** 2026-06-18

---

## Status key

| Symbol | Meaning |
| ------ | ------- |
| ⬜ **none** | Not started |
| 🟡 **stub** | Scaffold / decode-only |
| 🟡 **partial** | Works in some paths; gaps remain |
| 🟢 **render** | Production render/sync path |
| 🔵 **client-only** | Renderer owns; scene cannot author via ECS API |

**Phases:** 1 = scene boot · 2 = player/physics · 3 = input/media/motion · 4 = avatars · 5 = multiplayer · 6 = polish

---

## Summary

| Area | Tracked | 🟢 Done | 🟡 Partial | ⬜ Not started |
| ---- | ------- | ------- | ---------- | -------------- |
| ECS components | 65 | ~29 | ~5 | ~31 |
| Client UI | 18 | 13 | 0 | 5 |
| Networking | 16 | 13 | 2 | 1 |
| Performance | 15 | 12 | 2 | 1 |
| ~system modules | 9 | 5 | 2 | 2 |

*Exact counts: dev panel or `integrationRegistry.ts`.*

---

## ECS components (SDK7)

Source of truth for IDs: `@dcl/sdk` + `registry.ts`. When adding support: update **`registry.ts`**, **`mirrorComponents.ts`**, and this section.

### Core & render (Phase 1–1b)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| Transform | 1 | 🟢 | EntityStore + `dclTransform.ts` |
| Tags | — | 🟢 | Mirror CRDT; `getEntitiesByTag()` |
| VisibilityComponent | 1081 | 🟢 | `obj.visible` |
| GltfContainer | 1041 | 🟢 | Budgeted attach + reload on src change |
| MeshRenderer | 1018 | 🟢 | Primitives + custom UVs |
| Material | 1017 | 🟢 | PBR/unlit + video textures |
| Animator | 1042 | 🟢 | `AnimatorBridge` |
| Billboard | 1090 | 🟢 | `BillboardBridge` |
| LightSource | 1079 | 🟢 | Culling + quality tiers |
| TextShape | 1030 | 🟢 | Canvas texture planes |
| GltfContainerLoadingState | 1049 | ⬜ | Optional loading UI |

### Physics & input (Phase 2–3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| MeshCollider | 1019 | 🟢 | PhysX static + GLTF trimesh |
| AvatarLocomotionSettings | 1211 | 🟢 | Read for jump tuning |
| InputModifier | 1078 | 🟢 | Read path |
| PointerEvents | 1062 | 🟢 | Raycast + hover hints + CRDT |
| PointerEventsResult | 1063 | 🔵 | Grow-only to worker |
| PrimaryPointerInfo | 1209 | 🔵 | Cursor ray on RootEntity |
| Raycast | 1067 | ⬜ | Scene → engine ray |
| TriggerArea | 1060 | 🟢 | Volume enter/exit — `TriggerAreaSystem` + grow-only `TriggerAreaResult` |

### Media & motion (Phase 3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| VideoPlayer | 1043 | 🟢 | `VideoPlayerBridge` — decode, texture, pointer play/pause, end replay |
| VideoEvent | 1044 | 🔵 | Grow-only playback events → worker (`injectRendererGrowOnlyAppends`) |
| Tween | 1102 | 🟢 | Transform + textureMove |
| TweenSequence | 1104 | 🟢 | Genesis blimp orbit |
| TweenState | 1103 | 🔵 | Written by TweenBridge |
| AudioSource / AudioStream | 1020/1021 | ⬜ | |

### Avatars (Phase 4)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| AvatarShape | 1080 | 🟢 | NPC compose + name tags |
| **AvatarAttach** | **1073** | **🟢** | **Tier B — bone sampling, worker Transform batch** |
| AvatarEmoteCommand | 1088 | 🟢 | Player + NPC emotes |
| PlayerIdentityData | 1089 | 🔵 | Wallet / display name |
| AvatarEquippedData | 1091 | 🔵 | Client → scene |
| AvatarBase / AvatarModifierArea | 1087/1070 | ⬜ | |

### Networking & environment (Phase 5–6)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| NetworkEntity / NetworkParent | — | 🟡 | Projection decode + parent strip |
| SkyboxTime | 1210 | 🟢 | Day/night + fixed time |
| UiTransform … UiDropdown | 1050+ | ⬜ | In-scene UI (HUD is separate) |
| ParticleSystem / NftShape | 1217/1040 | ⬜ | |

### ~system modules (worker shim)

| Module | Status | Notes |
| ------ | ------ | ----- |
| EngineApi | 🟢 | CRDT + comms sendBatch/subscribe |
| Runtime | 🟢 | getSceneInformation, getRealm |
| RestrictedActions | 🟡 | movePlayerTo, emotes, openExternalUrl ✅ |
| CommunicationsController | 🟢 | sendBinary, comms topic |
| UserIdentity | 🟢 | getUserData + mirror ECS |
| SignedFetch | 🟢 | ADR-44 via worker RPC |
| CommsApi | 🟡 | topics ✅ · getActiveVideoStreams ⬜ |
| EnvironmentApi / Testing | ⬜ | |

---

## Client UI (browser HUD)

DOM overlay — not in-scene `UiTransform`.

| Feature | Status |
| ------- | ------ |
| Splash / login, loading + hydration timer | 🟢 |
| Sidebar, chat, emote wheel, minimap, world card | 🟢 |
| Debug panel, dev progress panel (`</>`) | 🟢 |
| Settings: Events, Map, Backpack, Graphics | 🟢 |
| Settings: Places, Communities, Gallery | ⬜ |
| In-scene ECS UI, voice/mic UI | ⬜ |

---

## Networking & social

| Feature | Status |
| ------- | ------ |
| RFC4 movement, profile, emote, scene chat | 🟢 |
| LiveKit scene/world/island rooms | 🟢 |
| Remote avatars + load queue | 🟢 |
| SignedFetch, Catalyst content, wallet session | 🟢 |
| ECS NetworkEntity scene sync | 🟡 stub |
| Spatial voice UI | ⬜ |

---

## Performance & rendering

| Feature | Status |
| ------- | ------ |
| CRDT projection + diff consumer | 🟢 |
| EntityStore (Phase 4) | 🟢 |
| **AvatarAttach Tier B** | **🟢** |
| PointerEvents cache, LightManager culling | 🟢 |
| GLTF hydration budgets, GLB parse pool, AssetCache IDB | 🟢 |
| PhysX lazy load, collider prewarm, Hyperfy grouped GLTF actors | 🟢 |
| GLTF InstancedMesh | ⬜ |
| Shadow pass tuning, full-resync interval | 🟡 partial |

---

## How to update

1. Implement the feature in code.
2. Set status in `src/dcl/ecs/registry.ts` (ECS) and/or `integrationRegistry.ts` (UI/net/perf).
3. Add a short note to [PROGRESS.md](./PROGRESS.md) when shipping a milestone.
4. Open a PR — see [PR_CHECKLIST.md](./PR_CHECKLIST.md).

---

## Related

- [PROGRESS.md](./PROGRESS.md) — milestone narrative (public: `github.com/lastraum/dcl-threejs-client`)
- [CLAIMS.yaml](./CLAIMS.yaml) — who is working on what
- [CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md) — deploy your own test world
- [AGENTS.md](./AGENTS.md) — AI/human onboarding