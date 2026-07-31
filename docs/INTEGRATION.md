# Three.js Client — Integration & ECS Status

> **Purpose:** Single checklist for ECS components, client UI, networking, and performance.  
> **Machine-readable:** `src/dcl/ecs/registry.ts` + `src/client/dev/integrationRegistry.ts`  
> **In-app:** Dev panel (`</>`) → **Integration status** tab  
> **Milestone log:** [PROGRESS.md](./PROGRESS.md) (also loaded live from GitHub in dev panel)  
> **Community claims:** [CLAIMS.yaml](./CLAIMS.yaml) (synced from GitHub `in-progress` issues)
> **Last updated:** 2026-07-31 (**v1.6.x** — EnvironmentApi/Testing + AudioAnalysis host fill; see [PROGRESS.md](./PROGRESS.md))

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
| ~system modules | 9 | 9 | 0 | 0 | — |

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
| GltfNodeModifiers | 1099 | 🟢 | Scene-graph path (Group→meshes); de-instance; restore on remove; videoTexture re-apply; static map U flip when GLB UVs L–R mirrored |
| MeshRenderer | 1018 | 🟢 | Primitives + custom UVs · docs-order dual-face planes (v21) · marquee re-basis separate |
| Material | 1017 | 🟢 | PBR/unlit + video; `cast_shadows` default **true** (omit = on); AUTO cutout only with alphaMap |
| Animator | 1042 | 🟢 | `AnimatorBridge` — shouldReset one-shots · hold on playing=false · PART hull candidates while running ([COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md)) |
| Billboard | 1090 | 🟢 | `BillboardBridge` |
| LightSource | 1079 | 🟢 | Culling + quality tiers |
| TextShape | 1030 | 🟢 | Canvas planes · docs-order UVs · FrontSide · `scale.x<0` map U flip (Poker boards) |
| GltfContainerLoadingState | 1049 | 🔵 | Host LWW from `ThreeBridge` attach path — LOADING→FINISHED/NOT_FOUND/ERROR → encoder + worker inject |

### Physics & input (Phase 2–3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| MeshCollider | 1019 | 🟢 | PhysX static + GLTF trimesh · ROOT actor T+R · PART world-cook on hull motion ([COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md)) |
| AvatarLocomotionSettings | 1211 | 🟢 | jump / doubleJump / glidingSpeed / glidingFallingSpeed / hardLandingCooldown |
| PhysicsCombinedForce | 1216 | 🟢 | PE force → external XZ + effective-g Y; ×`20/9.8` arcade scale; 1.5× while gliding (`externalPhysics.ts`) |
| PhysicsCombinedImpulse | 1215 | 🟢 | Explorer-raw Δv (no g-scale); eventId **or** LWW Lamport for plaza eventId=0; unground + cancel fall |
| InputModifier | 1078 | 🟢 | Read path |
| PointerLock | 1074 | 🔵 | Renderer writes CameraEntity; right-click (or Tab) toggles lock; lock movement = orbit look |
| PointerEvents | 1062 | 🟢 | Raycast + hover hints + CRDT |
| PointerEventsResult | 1063 | 🔵 | Grow-only to worker |
| PrimaryPointerInfo | 1209 | 🔵 | Cursor ray on RootEntity |
| Raycast | 1067 | 🟢 | `RaycastSystem` + grow-only `RaycastResult` |
| TriggerArea | 1060 | 🟢 | Volume enter/exit — CCT+PE · parent-first world matrix · immediate append flush for impulse pads |

### Camera (Phase 2–3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| MainCamera | 1075 | 🟢 | Hot `player-frame`; bind target via `vc-bind-hydrate` |
| VirtualCamera | 1076 | 🟢 | `VirtualCameraBridge` — world-flat hydrate; PE-follow; freecam orbit lock while MainCamera VC-bound; aim via lookAt (no hard-coded iso offsets) |
| CameraMode | 1072 | 🔵 | Renderer writes 1st/3rd on CameraEntity from freecam distance |
| CameraModeArea | 1071 | 🟢 | Volume forces 1st/3rd freecam; cinematic ignored (VC path) |
| **In-World Camera (client)** | — | 🟢 | `PhotoCameraController` owns `SceneHost.camera` while active; blocked when scene VirtualCamera is bound |

### Media & motion (Phase 3)

| Component | ID | Status | Notes |
| --------- | -- | ------ | ----- |
| VideoPlayer | 1043 | 🟢 | `VideoPlayerBridge` — decode, texture, pointer play/pause, end replay |
| VideoEvent | 1044 | 🔵 | Grow-only playback events → worker (`injectRendererGrowOnlyAppends`) |
| Tween | 1102 | 🟢 | Transform + textureMove · ROOT collider follow when Transform dirty |
| TweenSequence | 1104 | 🟢 | Genesis blimp orbit |
| TweenState | 1103 | 🔵 | Written by TweenBridge |
| AudioSource | 1020 | 🟢 | `AudioSourceBridge` — buffer clips; in-world + player-parent emote gain |
| AudioEvent | 1105 | 🔵 | Grow-only MediaState events → worker |
| AudioStream | 1021 | 🟢 | `AudioStreamBridge` — HTTP/HLS; voice-chat volume category |
| AudioAnalysis | 1212 | 🔵 | Host LWW fill — same entity as AudioSource/Stream/VideoPlayer; RAW + LOG (gain defaults 5 / 0.05); HLS/LiveKit zeros (Explorer); parallel pre-panner AnalyserNode |

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
| 🟡 | UiTransform · UiText · UiBackground · UiInput · UiDropdown |

### ~system modules (worker shim)

| Module | Status | Notes |
| ------ | ------ | ----- |
| EngineApi | 🟢 | CRDT + comms sendBatch/subscribe |
| Runtime | 🟢 | getSceneInformation, getRealm |
| RestrictedActions | 🟢 | movePlayerTo · teleportTo · changeRealm · triggerEmote · triggerSceneEmote · openExternalUrl · openNftDialog · copyToClipboard · setCommunicationsAdapter |
| CommunicationsController | 🟢 | sendBinary, comms topic |
| UserIdentity | 🟢 | getUserData + mirror ECS |
| SignedFetch | 🟢 | ADR-44 via worker RPC |
| CommsApi | 🟢 | getActiveVideoStreams · subscribeToTopic · unsubscribeFromTopic · publishData · consumeMessages |
| EnvironmentApi | 🟢 | SDK6-compat: bootstrap · preview · platform · unsafe · realm · explorer config · time |
| Testing | 🟢 | plan · logTestResult · setCameraTransform; screenshot compare stub |

---

## Client UI (browser HUD)

DOM overlay — not in-scene `UiTransform`.

| Feature | Status |
| ------- | ------ |
| Explorer auth sheet + session resume; loading + hydration timer | 🟢 |
| Multi-provider auth (Google/Discord/Apple/X/WC/MetaMask via auth-dapp) | 🟢 |
| Sidebar, 3D chat panel (+ DCM v1 inline images), emote wheel, location pill | 🟢 |
| **2D social chat dock (FAB)** | 🟢 | Bottom-right expand/collapse · restore last thread/list · multi-room tabs · × on Explore · idle empty centered text |
| **Circular Genesis minimap** (parcel play HUD) | 🟢 | Satellite basemap circle under pill; facing triangle; peer dots; click → in-world Map (embedded); worlds hide minimap |
| Debug panel, dev progress panel (`</>`) | 🟢 |
| Settings overlay: Events, Map, Backpack, Places, Gallery | 🟢 | Map tab embedded when opened from minimap / shell (no page HUD chrome) |
| **In-World Camera (C)** | 🟢 | Dedicated photo fly mode (not orbit freecam) · Space shutter · FOV scroll · pointer-lock look · review 3/4·1/4 · Save → Camera Reel |
| **Settings → Gallery (K)** | 🟢 | Camera Reel list/detail · public/delete/link · thumb ⋮ menu · signed fetch |
| Backpack wearables equip + Catalyst profile deploy | 🟡 | Inventory/equip/preview/deploy + **in-world reload from session** 🟢 · emotes tab / outfits / marketplace ⬜ · mobile sheets 🟢 |
| Profile pills + right-click profile menu (+ copy wallet) | 🟢 |
| Overhead name tags (`featureToggles.nameTags` / `?nameTags=` lock; **N** = local + remotes + AvatarShapes) | 🟢 |
| Hide all UI (**U**) | 🟢 | Client chrome + scene UI + overlays |
| Chat image lightbox | 🟢 | Inline DCM images → top-z modal |
| Preferences panel (P / ⚙): Graphics preset/shadows/lights/res/FPS + lighting | 🟢 |
| Preferences → Sounds volume sliders | 🟢 |
| Preferences: Controls, Chat tabs | 🟡 | Mouse sensitivity live; chat translate prefs 🟢 · keybinds pending |
| Settings: Communities | 🟢 | Browse + modal · announce/start-voice **owner/mod/admin** · voice join/end-all · community chat open into dock |
| Community HUD toasts | 🟢 | Top-center in-world · posts poll + Social WS voice · companion-aligned copy |
| In-scene ECS UI | 🟡 | Yoga + DOM · hit-map 🟢 · UiBackground nine-slice + **Color4×texture multiply** 🟢 · instant solid tint · text-measure polish remain |
| Voice / mic UI | 🟢 | Nearby voice panel · Speak / hold T · mute-in-bg · name-tag bars · **3D PositionalAudio** |

---

## Networking & social

| Feature | Status |
| ------- | ------ |
| RFC4 movement, profile, emote, scene chat + DCM chat media | 🟢 | `Movement.glideState` encode/decode for Explorer glider |
| LiveKit scene/world/island rooms | 🟢 | Worlds: world room voice; parcels: island+scene voice; archipelago genesis Z correct |
| **Nearby voice (browser ↔ Explorer)** | 🟢 | PTT/Speak · mute until in-play · landing handoff keepLiveKit · name-tag bars |
| **2D multi-room scene chat** (`SceneChatRoomPool`) | 🟢 | Open tabs stay joined across navigate (companion multi-text-chats); FAB dock UX |
| **Landing cast / stream keys** (Join Live, guest OK) | 🟢 | Gatekeeper adapter; mute; stream-end restores details |
| Remote avatars + load queue | 🟢 | GliderProp per peer when glideState open/gliding |
| Double-jump clockwise Y twirl (DCL / VRM / ODK) | 🟢 | Shared `DoubleJumpTwirl`; optional `double_jump.glb`; then hold-Space glide |
| SignedFetch, Catalyst content, wallet + guest session | 🟢 |
| ECS NetworkEntity scene sync | 🟢 P0–P3 host path |
| Community text / PM router | 🟢 | **1:1 DMs** + **community group text** on ADR-208 private-messages LiveKit room (topic `dcl.community.chat:{id}`, fan-out to members) |
| Community voice | 🟡 | Join/leave/end-for-everyone · LiveKit session · WS updates + REST fallback; gatekeeper may require service Bearer |
| Spatial voice (3D falloff) | 🟢 | `PositionalAudio` on remote avatar roots (ref 6 m / max 45 m); one source per peer |
| Elevated / tower spawn floor | 🟢 | Stage PE spawn before script; wait CCT ground; probe preferNear authored Y; reject roof false-grounds |

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
| Scene GLTF emissive LEDs (neon mats) | 🟢 | Property-based; untextured → additive MeshBasic; P4 bloom from emissive×intensity |
| User sun/moon lighting + exposure sliders | 🟢 |
| Sun/hemi intensity match vs Explorer | 🟢 | anim peak 2.72 + trilight; user sliders still override |
| GLTF hydration budgets, GLB parse pool, AssetCache IDB | 🟢 |
| PhysX lazy load, collider prewarm, Hyperfy grouped GLTF actors | 🟢 |
| Spawn settle onto authored floor (elevated decks) | 🟢 | `settleSpawnOntoFloor` + `waitForSpawnFloorReady`; short CCT drop + multi-XZ probe |
| GLTF InstancedMesh | 🟡 partial | Static multi-hash path; sustained Transform motion promotes to private clone (coins/projectiles) |
| Swept projectile hits (bundle rewrite) | 🟢 | `patchProjectileSweptHits` — XZ segment–cylinder + origin snapshot |
| Large multi-MB scene worker boot | 🟢 | Needle react-ecs / engine-loop patches; main-thread yield |
| PlayerEntity reserved Transform parent | 🟢 | Chest attach root + reparent (weapons mid-match) |
| CUSTOM_EVENT reliable + auth pin | 🟢 | LiveKit / CommsService combat events |
| Full-scene bloom / HDR post | 🟢 | Emissive-only extract · depth occluders · sky excluded · HalfFloat HDR · Graphics prefs; MSAA+bloom concurrent open |
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