# Three.js Client — Integration & ECS Status

> **Purpose:** Single checklist for ECS components, client UI, networking, and performance.  
> **Machine-readable:** `src/dcl/ecs/registry.ts` + `src/client/dev/integrationRegistry.ts`  
> **In-app:** Dev panel (`</>`) → **Integration status** tab  
> **Milestone log:** [PROGRESS.md](./PROGRESS.md) (also loaded live from GitHub in dev panel)  
> **Community claims:** [CLAIMS.yaml](./CLAIMS.yaml) (synced from GitHub `in-progress` issues)
> **Last updated:** 2026-07-16 (NftShape 🟢 + openNftDialog; GltfContainerLoadingState 🔵)

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

| Area | Tracked | 🟢 Done | 🟡 Partial | ⬜ Not started | 🔵 Client-only |
| ---- | ------- | ------- | ---------- | -------------- | -------------- |
| ECS components | 65 | 39 | 5 | 2 | 19 |
| Client UI | see `integrationRegistry.ts` | | | | |
| Networking | see `integrationRegistry.ts` | | | | |
| Performance | see `integrationRegistry.ts` | | | | |
| Environment | 4 | 4 | 0 | 0 | — |
| ~system modules | 9 | 5 | 2 | 2 | — |

*ECS counts from `src/dcl/ecs/registry.ts`. **Without full parity** = ⬜ + 🟡 = **7**. Client-only (🔵) is intentional renderer→scene ownership, not a missing feature — e.g. AssetLoadLoadingState, GltfContainerLoadingState, TweenState, EngineInfo. **Tags** + `getEntitiesByTag()` are 🟢.*

---

## ECS components (SDK7)

Source of truth for IDs: `@dcl/sdk` + `registry.ts`. When adding support: update **`registry.ts`**, **`mirrorComponents.ts`**, and this section.

### Core & render (Phase 1–1b)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| Transform | 1 | 🟢 | EntityStore + `dclTransform.ts` |
| Tags | — | 🟢 | Mirror CRDT; `getEntitiesByTag()` |
| Name | — | 🟢 | `core-schema::Name` → Three.js `Group.name` (debug / tooling) |
| VisibilityComponent | 1081 | 🟢 | `obj.visible` |
| GltfContainer | 1041 | 🟢 | Budgeted attach + reload on src change |
| GltfNodeModifiers | 1099 | 🟢 | Full path material/castShadows on GLB nodes; de-instance; restore on remove; videoTexture re-apply |
| MeshRenderer | 1018 | 🟢 | Primitives + custom UVs |
| Material | 1017 | 🟢 | PBR/unlit + video textures; empty Creator Hub slots ignored; AUTO cutout only with alphaMap (Unity) |
| Animator | 1042 | 🟢 | `AnimatorBridge` |
| Billboard | 1090 | 🟢 | `BillboardBridge` |
| LightSource | 1079 | 🟢 | Culling + quality tiers |
| TextShape | 1030 | 🟢 | Canvas texture planes |
| GltfContainerLoadingState | 1049 | 🔵 | Host LWW from `ThreeBridge` attach path — LOADING→FINISHED/NOT_FOUND/ERROR → encoder + worker inject |

### Physics & input (Phase 2–3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| MeshCollider | 1019 | 🟢 | PhysX static + GLTF trimesh |
| AvatarLocomotionSettings | 1211 | 🟢 | Read for jump tuning |
| PhysicsCombinedForce | 1216 | ⬜ | Apply force to physics bodies |
| PhysicsCombinedImpulse | 1215 | ⬜ | Apply impulse to physics bodies |
| InputModifier | 1078 | 🟢 | Read path |
| PointerLock | 1074 | 🔵 | Renderer writes CameraEntity; right-click (or Tab) toggles lock; lock movement = orbit look |
| PointerEvents | 1062 | 🟢 | Raycast + hover hints + CRDT |
| PointerEventsResult | 1063 | 🔵 | Grow-only to worker |
| PrimaryPointerInfo | 1209 | 🔵 | Cursor ray on RootEntity |
| Raycast | 1067 | 🟢 | `RaycastSystem` + grow-only `RaycastResult` |
| TriggerArea | 1060 | 🟢 | Volume enter/exit — `TriggerAreaSystem` + grow-only `TriggerAreaResult` |

### Camera (Phase 2–3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| MainCamera | 1075 | 🟢 | Hot `player-frame`; bind target via `vc-bind-hydrate` |
| VirtualCamera | 1076 | 🟢 | `VirtualCameraBridge` — locked world-flat hydrate; `parent===lookAt` PE-follow; live Transform exclusive while bound |
| CameraMode | 1072 | 🔵 | Renderer writes 1st/3rd on CameraEntity from freecam distance |
| CameraModeArea | 1071 | 🟢 | Volume forces 1st/3rd freecam; cinematic ignored (VC path) |

### Media & motion (Phase 3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| VideoPlayer | 1043 | 🟢 | `VideoPlayerBridge` — decode, texture, pointer play/pause, end replay |
| VideoEvent | 1044 | 🔵 | Grow-only playback events → worker (`injectRendererGrowOnlyAppends`) |
| Tween | 1102 | 🟢 | Transform + textureMove |
| TweenSequence | 1104 | 🟢 | Genesis blimp orbit |
| TweenState | 1103 | 🔵 | Written by TweenBridge |
| AudioSource | 1020 | 🟢 | `AudioSourceBridge` — buffer clips; in-world + player-parent emote gain |
| AudioEvent | 1105 | 🔵 | Grow-only MediaState events → worker |
| AudioStream | 1021 | 🟢 | `AudioStreamBridge` — HTTP/HLS; voice-chat volume category |
| AudioAnalysis | 1212 | 🔵 | Spectrum / analysis data for scenes — write path TBD |

### Avatars (Phase 4)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| AvatarShape | 1080 | 🟢 | NPC compose + name tags |
| **AvatarAttach** | **1073** | **🟢** | **Tier B — bone sampling, worker Transform batch** |
| AvatarEmoteCommand | 1088 | 🟢 | Player + NPC emotes |
| PlayerIdentityData | 1089 | 🔵 | Wallet / display name |
| AvatarEquippedData | 1091 | 🔵 | Client → scene |
| AvatarBase | 1087 | 🔵 | Host LWW — local PlayerEntity + remote synthetic avatars (name/body/colors); with PlayerIdentityData + AvatarEquippedData |
| AvatarModifierArea | 1070 | 🟢 | Volume hide avatars + disable passports (`AvatarModifierAreaSystem`) |

### Networking & environment (Phase 5–6)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| NetworkEntity / NetworkParent | — | 🟢 | Typed projection + local parent resolve (P3) |
| SyncComponents / `syncEntity` | — | 🟢 | P0–P3 host path · directed LiveKit · size cap |
| SkyboxTime | 1210 | 🟢 | Scene fixed → session custom → Auto; ECS/json lock snaps on cold bind |
| UiTransform … UiDropdown | 1050+ | 🟡 | Yoga + DOM partial — results writeback; polish gaps |
| ParticleSystem | 1217 | 🟢 | `ParticleSystemBridge` — GPU billboard sprites |
| MapPin | 1097 | 🟢 | Mirror + `MapPinStore` list (deprecated upstream; still honored) |
| NftShape | 1040 | 🟢 | `NftShapeBridge` — OpenSea proxy image + **Explorer FBX frames** (`/nft-frames/*.fbx`); animated GIF; `openNftDialog` HTML modal (RestrictedActions) |

| AssetLoad | 1213 | 🟢 | Preload scene paths into caches (`AssetLoadBridge`) — GLB parse + texture + audio |
| AssetLoadLoadingState | 1214 | 🔵 | Grow-only LOADING/FINISHED/NOT_FOUND/ERROR per asset → encoder |
| EngineInfo | 1048 | 🔵 | RootEntity — host LWW via encoder (like Unity); `frameNumber` · `tickNumber` · `totalRuntime` (ADR-148); NOT peer-synced |
| RealmInfo | 1106 | 🔵 | RootEntity — host LWW via encoder; baseUrl/realmName/networkId/commsAdapter/preview/room/`isConnectedSceneRoom`; NOT peer-synced |

### Gaps still open (ECS only)

| Status | Components |
| ------ | ---------- |
| ⬜ | PhysicsCombinedForce · PhysicsCombinedImpulse |
| 🟡 | UiTransform · UiText · UiBackground · UiInput · UiDropdown |

### ~system modules (worker shim)

| Module | Status | Notes |
| ------ | ------ | ----- |
| EngineApi | 🟢 | CRDT + comms sendBatch/subscribe |
| Runtime | 🟢 | getSceneInformation, getRealm |
| RestrictedActions | 🟡 | movePlayerTo, emotes, openExternalUrl, openNftDialog ✅ |
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
| Explorer auth sheet + session resume; loading + hydration timer | 🟢 |
| Multi-provider auth (Google/Discord/Apple/X/WC/MetaMask via auth-dapp) | 🟢 |
| Sidebar, chat (+ DCM v1 inline images), emote wheel, location pill | 🟢 |
| **Circular Genesis minimap** (parcel play HUD) | 🟢 | Satellite basemap circle under pill; click → in-world Map (embedded); worlds hide minimap |
| Debug panel, dev progress panel (`</>`) | 🟢 |
| Settings overlay: Events, Map, Backpack, Places, Gallery | 🟢 | Map tab embedded when opened from minimap / shell (no page HUD chrome) |
| Backpack wearables equip + Catalyst profile deploy | 🟡 | Inventory/equip/preview/deploy 🟢 · emotes tab / outfits / marketplace ⬜ · mobile sheets 🟢 |
| Profile pills + right-click profile menu (+ copy wallet) | 🟢 |
| Overhead name tags (hide via `featureToggles.nameTags` / `?nameTags=`) | 🟢 |
| Preferences panel (P / ⚙): Graphics preset/shadows/lights/res/FPS + lighting | 🟢 |
| Preferences → Sounds volume sliders | 🟢 |
| Preferences: Controls, Chat tabs | 🟡 | Mouse sensitivity live; keybinds pending |
| Settings: Communities | ⬜ | 2D `/communities` browse exists; in-world tab lag |
| In-scene ECS UI | 🟡 | Yoga + DOM partial — Creator modal / hit-map polish remain |
| Voice / mic UI | 🟢 | Nearby voice panel · Speak / hold T · mute-in-bg · name-tag bars; spatial 3D next |

---

## Networking & social

| Feature | Status |
| ------- | ------ |
| RFC4 movement, profile, emote, scene chat + DCM chat media | 🟢 |
| LiveKit scene/world/island rooms | 🟢 | Worlds: world room voice; parcels: island+scene voice; archipelago genesis Z correct |
| **Nearby voice (browser ↔ Explorer)** | 🟢 | PTT/Speak · mute until in-play · landing handoff keepLiveKit · name-tag bars |
| **2D multi-room scene chat** (`SceneChatRoomPool`) | 🟢 | Open tabs stay joined across navigate (companion multi-text-chats) |
| **Landing cast / stream keys** (Join Live, guest OK) | 🟢 | Gatekeeper adapter; mute; stream-end restores details |
| Remote avatars + load queue | 🟢 |
| Double-jump clockwise Y twirl (DCL / VRM / ODK) | 🟢 | Shared `DoubleJumpTwirl`; optional `double_jump.glb` |
| SignedFetch, Catalyst content, wallet + guest session | 🟢 |
| ECS NetworkEntity scene sync | 🟢 P0–P3 host path |
| Community text / PM router | ⬜ local echo only |
| Spatial voice (3D falloff) | ⬜ | LiveKit tracks + HUD done; PositionalAudio pending |

---

## Performance & rendering

| Feature | Status |
| ------- | ------ |
| CRDT projection + diff consumer | 🟢 |
| EntityStore (Phase 4) | 🟢 |
| **AvatarAttach Tier B** | **🟢** |
| PointerEvents cache, LightManager culling | 🟢 |
| Genesis sky + cloud lighting (camera-centered dome) | 🟢 |
| Sun/moon azimuth parity vs Explorer (negate-X celestial) | 🟢 |
| Trilight ambient (sky + equator + ground) | 🟢 |
| Soft directional sun shadows | 🟢 |
| Island shore receives shadows; wearables cast | 🟢 |
| Skybox time authority (scene / session / auto) | 🟢 |
| Low-end scene worker timing + adaptive abort backoff | 🟢 |
| Boot/hydration: main.crdt seed, composite preload, unified GLB | 🟢 |
| Landscapes, FFT ocean, Perlin scatter foliage | 🟢 |
| Scene GLTF emissive LEDs (neon mats) | 🟡 partial |
| User sun/moon lighting + exposure sliders | 🟢 |
| Sun/hemi intensity match vs Explorer | 🟢 | anim peak 2.72 + trilight; user sliders still override |
| GLTF hydration budgets, GLB parse pool, AssetCache IDB | 🟢 |
| PhysX lazy load, collider prewarm, Hyperfy grouped GLTF actors | 🟢 |
| GLTF InstancedMesh | ⬜ |
| Shadow pass tuning | 🟢 | soft + soft directional sun |

---

## How to update

1. Implement the feature in code.
2. Set status in `src/dcl/ecs/registry.ts` (ECS) and/or `integrationRegistry.ts` (UI/net/perf).
3. Add a short note to [PROGRESS.md](./PROGRESS.md) when shipping a milestone.
4. Open a PR — see [PR_CHECKLIST.md](./PR_CHECKLIST.md).

---

## Related

- [PROGRESS.md](./PROGRESS.md) — milestone narrative
- [ARCHITECTURE.md](./ARCHITECTURE.md) — scene I/O + debt
- [CLAIMS.yaml](./CLAIMS.yaml) — who is working on what
- [AGENTS.md](./AGENTS.md) — onboarding