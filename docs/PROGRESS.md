# Three.js DCL Client — Progress Log

> Living document. Update after each meaningful milestone.  
> **Pick-up backlog:** [TASKS.yaml](./TASKS.yaml) — claim tasks via [CONTRIBUTING.md](../CONTRIBUTING.md).  
> **Last updated:** 2026-06-18 (AudioSource + AudioStream ⬜ not tested · Preferences Sounds 🟡 · Lighting ✅)  
> **Current phase:** **Phase 4 closed** — EntityStore + **AvatarAttach Tier B** + **TriggerArea Tier A** + **VideoPlayer** shipped. **Media:** AudioSource + AudioStream implemented (awaiting user test). Next: Raycast, voice UI, e10 perf.
> **Integration checklist:** [INTEGRATION.md](./INTEGRATION.md) · **Tasks:** [TASKS.yaml](./TASKS.yaml)

---

## 🎉 Milestone — Audio ECS + Preferences Sounds (2026-06-18)

**Status: implemented, not user-tested yet** — build passes; no in-world confirmation on a stream/clip test scene.

| Area | Status | Notes |
| ---- | ------ | ----- |
| **AudioSource** (1020) | ⬜ **not tested** | `AudioSourceBridge` + `SceneAudioPlayer` — THREE buffer clips, spatial/global, play/pause/seek/loop/volume/pitch |
| **AudioStream** (1021) | ⬜ **not tested** | `AudioStreamBridge` + `SceneAudioStreamPlayer` — HTTP/HLS via hidden `HTMLAudioElement`, spatial min/max distance |
| **AudioEvent** (1105) | ⬜ **not tested** | Grow-only `MediaState` → worker (source + stream entities) |
| **Shared listener** | ✅ code | One `AudioListener` on camera; master volume from preferences |
| **Preferences → Sounds** | 🟡 **partial** | Volume sliders + mic picker + mute-in-background toggle; **live:** master + in-world; **saved only:** UI SFX, voice, avatar emotes |
| **Natural end sync** | ⬜ **not tested** | AudioSource writes `playing:false` LWW on clip end |

**Files:** `AudioSourceBridge.ts`, `SceneAudioPlayer.ts`, `AudioStreamBridge.ts`, `SceneAudioStreamPlayer.ts`, `AudioBufferCache.ts`, `SoundSettings.ts`, `SoundsSettingsView.ts`, `MicDeviceService.ts`, `mirrorComponents.ts`, `CrdtEncoder.ts`, `SceneScriptSystem.ts`

**Merged:** `lastraum` → `dev-latest` (`c608dbc`, 2026-06-18)

---

## 🎉 Milestone — Lighting & skybox polish (2026-06-18)

**User-confirmed working (opbadge / night mode):** scene LED strips read warm emissive (not flat white); skybox clouds white at midday; preferences panel opens over live world (orbit + WASD still work).

| Area | Status | Notes |
| ---- | ------ | ----- |
| **Preferences panel (P / ⚙)** | ✅ | Separate from main overlay — Graphics, Sounds, Controls, Chat tabs; right rail; no pointer-lock exit |
| **User lighting sliders** | 🟡 **partial** | **Scene Sun Light**, **Exposure** (day), **Scene Moon Light**, **Moon Exposure** (night) — persisted in `SunEnvironmentSettings` |
| **Skydome sun look** | ✅ | Locked to small disc / no corona (former 0% sliders removed) |
| **Skybox clouds** | ✅ | HDR cloud gradient tint + screen brighten + sun-facing lift; `toneMapped: false` on sky shader |
| **Scene GLTF emissives** | 🟡 **partial** | DCL model: clamp emissive RGB → `emissiveIntensity` (KHR strength 2–80+); named neon mats (`LightLED`, etc.) — **decent, room to improve** |
| **Baked emissive maps** | ✅ | Floor/wall bake mats skipped — no blowout |
| **Graphics settings stubs** | ⬜ | MSAA, bloom, resolution scale, shadow quality — UI placeholders only |
| **Custom skybox worlds** | 🟡 | User sliders affect Genesis path only; cubemap `/about` scenes hide `DclGenesisSky` |

**Files:** `PreferencesPanel.ts`, `SunEnvironmentSettings.ts`, `DclGenesisSky.ts`, `EnvironmentSystem.ts`, `sceneGltfEmissives.ts`, `GraphicsSettingsView.ts`

**Merged:** `lastraum` → `dev-latest` (2026-06-18)

---

## 🎉 Milestone — VideoPlayer ECS parity (2026-06-18)

**User-confirmed working:** `rickroll.dcl.eth` screen — auto-play on load, video texture on plane, pointer play/pause toggle, end-of-video replay on first click, pause/resume from current frame.

| Area | Status | Notes |
| ---- | ------ | ----- |
| Decoder | ✅ | `WebVideoPlayer` — HTMLVideoElement + `THREE.VideoTexture` (HLS via hls.js) |
| ECS bridge | ✅ | `VideoPlayerBridge` — projection ↔ decoder; grow-only `VideoEvent` outbound |
| Scene toggle | ✅ | Worker `VideoPlayer.getMutable().playing = !playing` via pointer CRDT |
| End-of-video | ✅ | Natural end syncs `playing:false` + LWW inject; click replays from start |
| Material | ✅ | Video texture binds at metadata; material pass on `onTextureReady` |
| Worker inject | ✅ | `VideoPlayer` LWW + `VideoEvent` append via renderer inject path |

**Files:** `WebVideoPlayer.ts`, `VideoPlayerBridge.ts`, `videoTextureOrientation.ts`, `injectRendererLwwPuts.ts`, `injectRendererGrowOnlyAppends.ts`, `CrdtEncoder.ts` (LWW capture)

---

## 🎉 Milestone — TriggerArea Tier A parity (2026-06-17)

**User-confirmed working:** box + sphere `TriggerArea` volumes fire scene `onTriggerEnter` / `onTriggerExit` callbacks; grow-only `TriggerAreaResult` CRDT delivery to the scene worker.

| Area | Status | Notes |
| ---- | ------ | ----- |
| Detection | ✅ | DCL-native math probes (default); optional PhysX Tier B via `?triggerParity` |
| CRDT path | ✅ | `TriggerAreaSystem` → `CrdtEncoder` → worker inject + awaited engine tick |
| Bundled scenes | ✅ | `patchSceneBundle` captures correct engine at `addTransport(renderer)` |
| Debug | ✅ | `?triggerverbose` probes · `npm run test:trigger` (11/11) |

**Files:** `TriggerAreaSystem.ts`, `triggerAreaMath.ts`, `triggerAreaEmit.ts`, `injectTriggerAreaAppends.ts`, `SceneScriptSystem.updateTriggerAreas()`

**PR:** [#2](https://github.com/lastraum/dcl-threejs-client/pull/2) → `dev-latest` (closes [#1](https://github.com/lastraum/dcl-threejs-client/issues/1))

---

## 🎉 Milestone — AvatarAttach Tier B parity (2026-06-17)

**User-confirmed working:** entities with `AvatarAttach` follow local player, remote peers, and `AvatarShape` NPC bones — SDK-parity avatar-relative `Transform` on the worker + composed world pose on the renderer.

| Area | Status | Notes |
| ---- | ------ | ----- |
| Bone sampling | ✅ | All `AvatarAnchorPointType` anchors; name-tag offset |
| Transform model | ✅ | `playerTransform ⊗ relativeTransform` — not raw world-matrix copy |
| Main thread | ✅ | `AvatarAttachBridge` — `projection.setRenderer` + EntityStore world apply |
| Worker batch | ✅ | `avatar-attach-transforms` message per frame |
| Targets | ✅ | LocalAvatar, RemoteAvatarManager, AvatarShapeBridge |
| Conflicts | ✅ | Attach wins over inbound Transform apply + Tween |

**Files:** `AvatarAttachBridge.ts`, `avatarAttachMath.ts`, `avatarAttachAnchors.ts`, `applyAvatarAttachTransforms.ts`, `World.bindAvatarAttachTargets()`

---

## 🎉 Milestone — Explorer visual parity (2026-06-12)

**Confirmed working:** side-by-side with Unity Explorer on `rickroll.dcl.eth` — scene layout, NPC positions, dancer rows, and environment props now match (no X-axis mirror).

### Root cause

DCL SDK7 uses a **left-handed** scene space (+X east, +Y up, +Z north). Three.js is **right-handed** with the same axis labels. Copying ECS transform bytes directly into `Object3D.position` / `quaternion` mirrored the entire scene on X vs Explorer.

### Fix — `src/bridge/dclTransform.ts`

Conversion at the **render boundary only** (simulation, comms wire, minimap, CRDT mirror stay in DCL meters):


| DCL (logical) | Three.js (display) |
| ------------- | ------------------ |
| position `(x, y, z)` | `(-x, y, z)` |
| quaternion `(x, y, z, w)` | `(-x, y, z, -w)` |
| yaw | negated |

Applied consistently to:

- `ThreeBridge` / `applyDclLocalTransform` — all ECS entities
- `PlayerSystem` — PhysX capsule display + bounds; `getPosition()` returns DCL for wire/minimap
- `ReservedEntitiesSync` — player/camera poses written back to CRDT in DCL space
- Landscape + water + PhysX ground tiles
- `RemoteAvatarManager` — inbound comms positions/yaws converted for display

**Do not** use `scale.x = -1` on a scene root (breaks normals / backface culling).

### Also shipped (same push)


| Area | Status | Notes |
| ---- | ------ | ----- |
| RFC4 movement encode/decode | 🟡 aligned | Bevy `global_crdt` + Unity Foundation wire — position X pass-through, velocity Z negated, yaw via `(yaw - π)` degrees |
| Comms plugin architecture | ✅ | Bevy-shaped `CommsService` — archipelago path, Scene packet routing |
| LiveKit session scaffold | ✅ | `LiveKitCommsSession` + movement broadcast loop |
| Remote avatar placeholders | ✅ | blank body → Catalyst profile swap + lerp |

### Next up — **social comms integration**

Goal: see other players in-scene **and** in the social layer (voice/presence) like Explorer — building on the coordinate fix so positions are trustworthy.


| Priority | Task |
| -------- | ---- |
| 1 | End-to-end peer visibility on realm comms (Two clients, same scene, correct positions) |
| 2 | Profile broadcast + remote avatar load on join |
| 3 | Voice / presence (LiveKit or realm adapter — match deployed `rickroll.dcl.eth` comms adapter) |
| 4 | Gatekeeper / signed-login if realm requires it |

**Comms references:** Bevy inbound · Unity Foundation outbound · dcl-companion LiveKit patterns.

---

## Glossary (SDK terms vs client status)

| Term | What it is | Client status |
| ---- | ---------- | ------------- |
| **Tags** | ECS component — string labels on entities (`Tags.tags: string[]`). Scenes query with `engine.getEntitiesByTag("door")` instead of hard-coded entity ids. Not a separate “tag” API on Transform. | ✅ **Mirror CRDT sync** — `getEntitiesByTag()` works when tags are set in scene or composite. |
| **`EngineApi.sendBatch`** | Legacy kernel API drained each frame by SDK `pollEvents()`. **SDK7 only consumes `comms` generic events** — other observables use ECS in the worker. | ✅ **SDK7 parity** — `comms` topic → queue → `onCommsMessage`. |
| **`EngineApi.subscribe`** | Scene registers interest in an `eventId`. We implement **`comms` only** (matches `@dcl/sdk` `pollEvents`). | ✅ **Implemented** — paired with `sendBatch`. |
| **`PET_PROXIMITY_*`** | `PointerEventType.PET_PROXIMITY_ENTER` / `PET_PROXIMITY_LEAVE` on **`PointerEvents`** — fires when the **player avatar walks within range** of an entity (no cursor ray). Distinct from **`TriggerArea`** (volume component + `TriggerAreaResult`). | ⬜ **Not implemented** — cursor hover/down/up only (`PointerEventsSystem`). |

---

## 🎉 Milestone — PhysX + LightSource FPS (2026-06-13)

**Confirmed working:** Genesis Plaza + RickRoll — local player feet on ground (matching NPCs/remotes), PhysX capsule debug aligned with avatar, **major FPS improvement** from LightSource culling in light-heavy scenes.

### PhysX / player grounding ✅

| Fix | Notes |
| --- | ----- |
| Capsule ↔ avatar alignment | Bone-based `feetAlign.ts` — soles at player root; removed wrong hardcoded pivot offset |
| Local player floating | Tighter ground sweep (0.22 m Hyperfy parity), feet snap on spawn/teleport/grounded frame; spawn Y defaults → 0 |
| PhysX debug toggles | Help panel — flat checkboxes for MeshCollider / GLTF / local capsule wireframes |
| Ground colliders | Per-parcel landscape boxes at y=0 — **no** infinite fallback plane |

### LightSource system ✅ (see [`lightsource-parity.md`](./lightsource-parity.md))

| Area | Status | Notes |
| ---- | ------ | ----- |
| Intensity / range / spot aim | ✅ | Candelas `/4000`, range clamp, spot target, decay=2 |
| `LightManager` | ✅ | 40 m cull · tier caps 4/6/10 · 3 spot shadow flags |
| Quality hook | ✅ | Debug panel tier + `renderQuality` API |
| Genesis Plaza FPS | ✅ | User-confirmed huge improvement vs uncapped lights |

### Pre-live blockers ✅ **CLEARED** (2026-06-13)

| Blocker | Status | Notes |
| ------- | ------ | ----- |
| **Emote GLB props** | ✅ **confirmed** | `SkeletonUtils.clone()` rebinds skinned particle props; Money/Clap/Kiss/Champagne props visible local + remote + AvatarShape |
| **Sun / skybox** | ✅ **confirmed** | Stronger sun + skydome halo; cloud blend fix (no blue speckle); shadows + tone mapping — see [`lightsource-parity.md`](./lightsource-parity.md) |

---

## 🎉 Milestone — Emote GLB props (2026-06-13)

**User-confirmed working:** profile emote wheel props (Money, Clap, Kiss, etc.) render and animate.

### Root cause

`Object3D.clone(true)` on emote GLBs left `SkinnedMesh` skeletons pointing at the **cached AssetCache root**, while `propMixer` animated **cloned bones** under the avatar — props never moved with visible meshes.

### Fix

- `SkeletonUtils.clone()` in `cloneEmotePropRoots()` — proper skinned-mesh rebind
- `propRoot` parented on avatar pivot; emote loads skip landscape material sanitizer (MASK particles)
- Scene-emote URNs resolve from scene manifest (not Catalyst profile path)

**Files:** `emotePlayback.ts`, `AvatarAnimations.ts`, `AssetCache.ts`, `profileEmotes.ts`

---

## Summary

Phase 0 **done**. Phase 1 **closed** (**GltfContainer ✅** — `ThreeBridge` + `AssetCache` on all GLTF scenes). **Phase 1b render bridges wired** (LightSource ✅ + LightManager, TextShape, Billboard, Animator). Phase 2a player **done** (PhysX grounding ✅, **GLTF `_collider` trimesh blocking ✅**). Phase 2c reserved entities **done**. Phase 4a–4c + 4b avatar **done** — **emote GLB props ✅**, **double-jump VFX ✅**, **`AvatarEmoteCommand` bridge ✅**. Phase 3 motion **`Tween` bridge ✅** — transform + textureMove + **Genesis blimp orbit (`TweenSequence`) ✅**. Phase 3a environment **closed** (sun + clouds ✅, **moon fill + night exposure ✅**). **Phase 3b `PointerEvents` ✅** — camera raycast + hover tooltips + CRDT results + **Explorer parity (2026-06-14)**: button icons, green/red highlight, per-entry distance, E/F/click/1–4/Space/Ctrl, scene `console.log` → client debug. Client chrome **expanded** (map, events, chat nav links + @mentions, **world location card**, **dev progress panel**, loading hold + **hydration elapsed timer (count-up)**). **Session GLB cache ✅** — survives teleports. **Explorer layout parity ✅**. Phase 5 **position sync aligned** + scene chat ✅ (140 char, nav links, @mention bubble highlight; Explorer dates ⬜). **Pre-live blockers cleared** — browser push candidate.

**Run:** `npm run dev` → `http://localhost:5173`

### Implementation principle — reference parity

Prefer **Unity Foundation Client / DCL Explorer** behavior for WASM (PhysX, comms codecs), Three.js rendering optimizations, LOD/asset streaming, and camera patterns. See **Reference parity** in [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md). Document MVP shortcuts (grass scatter, no scene LOD) so they can be closed against Unity source later.


| Route                 | Result                                                 |
| --------------------- | ------------------------------------------------------ |
| `/`                   | Blank 1×1 template + 3×3 padding                       |
| `/rickroll.dcl.eth`   | RickRoll world — parcels, spawn, full content manifest |
| `/name`               | Normalizes to `name.dcl.eth`                           |
| `/80,-1`              | Parcel coords (stub — throws)                          |
| `?world=name.dcl.eth` | Legacy query fallback                                  |
| `?orbit=1`            | Orbit camera (debug) instead of first-person player    |
| `?colliders=1`        | Wireframe MeshCollider debug overlay                   |
| `?profile=0x…`        | Catalyst profile — wearables, name tag, nameColor               |
| `?body=female`        | Default body shape when no profile                              |


**Try:** `http://localhost:5173/rickroll.dcl.eth?profile=0xC3E3…` — WASD move, jump, AvatarShape NPCs with name tags.

---

## Phase 0 — Landscape viewer ✅ **CLOSED**


| Area                           | Status | Notes                                                              |
| ------------------------------ | ------ | ------------------------------------------------------------------ |
| Vite + TS + Three.js scaffold  | ✅ Done | `package.json`, `vite.config.ts`, `tsconfig.json`                  |
| Scene resolution               | ✅ Done | `resolveSceneFromRoute` — about → entity → content manifest        |
| Path routing                   | ✅ Done | `route.ts` — `/:world.dcl.eth`, `/:x,y` stub, SPA fallback         |
| Render stats HUD               | ✅ Done | `RenderStats.ts` — FPS/MS panel, top-center                        |
| Coordinate system              | ✅ Done | SW corner = `(0,0,0)`; +X east, +Z north; 16 m parcels             |
| ECS → Three.js handedness      | ✅ Done | `dclTransform.ts` — LH DCL → RH Three at render boundary (2026-06-12) |
| Padding ring                   | ✅ Done | `ParcelGrid.landscapeParcelKeys()` — 1×1 → 3×3 grid                |
| Ground tiling                  | ✅ Done | `ground.glb` per parcel; **+8 m offset** (mesh is ±8 centered)     |
| Scene vs padding roles         | ✅ Done | Scene parcel = ground only; padding = scatter props                |
| External glTF textures         | ✅ Done | `DclTextureResolver.ts` — `FanstasyPack_TX.png`, `file1.png`, etc. |
| Asset loading                  | ✅ Done | `AssetCache` — GLTF + DRACO, dedup, texture preload                |
| Collider stripping             | ✅ Done | `LandscapeAssetSanitizer.ts` — hides `/_collider/i` meshes (not deleted) |
| Trees / bushes / rocks / grass | ✅ Done | `ParcelDecorator.ts` — parcel-seeded RNG                           |
| Tree appearance                | ✅ Done | Coral/pink tree01 + tree02 only; colliders hidden; alpha foliage   |
| Tree density                   | ✅ Done | 0–1 tree per padding parcel (~sparse Explorer-like ring)           |
| Compass HUD                    | ⬜ Removed | Replaced by circular minimap (no scene compass overlay)          |
| Basic scene lighting           | ✅ Done | Hemi + directional sun + fog (MVP — not day/night cycles)          |
| Orbit camera                   | ✅ Done | `SceneHost.ts` — spawn focus, shadows, damping                     |
| Unity Explorer structure       | ✅ Done | `src/dcl/landscape/` mirrors `DCL/Landscape/` layout               |
| Build                          | ✅ Done | `npm run build` passes                                             |


### Phase 0 success criteria

- [x] World loads from path `/name.dcl.eth` or legacy `?world=` (entity + content manifest)
- [x] Parcel ground blocks render under scene footprint + padding
- [x] glTF assets load without texture 404s (shared atlas resolver)
- [x] Stable orbit viewer on static landscape (render stats HUD)
- [x] Side-by-side parity check vs Unity Explorer — **layout + NPC positions ✅** (2026-06-12)

---

## Key fixes (2026-06-12 session)

### Parcel alignment

`ground.glb` is authored at **mesh center (±8 m)**, not SW corner. Parcel roots sit at SW; ground now gets `(8, 0, 8)` offset via `SceneSpace.ts` so tiles and props share SDK7 0–16 m bounds.

### Missing textures

Many DCL glTFs reference bare filenames (`FanstasyPack_TX.png`). `LoadingManager.setURLModifier` maps them to Catalyst IPFS hashes from `@dcl/asset-packs/catalog.json`.

### Broken trees

Empty-land tree glTFs include **collider meshes** (`Tree01_LOD01_collider`, `Sphere_collider`) that rendered as dark ovoids. Sanitizer hides `/_collider/i` meshes (kept for physics extraction) and fixes foliage `alphaTest`.

### Too many / wrong-colored trees

Reduced to **0–1 tree per padding parcel**. Scatter pool uses **tree01 (coral) + tree02 (pink)** only — skips teal tree03.

### Routing + world fetch

- `**route.ts`** — `/:segment` parses as parcel coords or ENS world name
- `**resolveSceneFromRoute**` — `GET /world/{name}/about` → entity id → `GET /contents/{id}` → parcels, spawn, content[], main entry
- HUD shows entity id, file counts, and `bin/scene.js` hash
- Vite `appType: 'spa'` for deep links

### Render stats

mrdoob **stats.js** panel top-center — closes out Phase 0 perf/viewer checkmark.

---

## Deferred: lighting & environment cycles ⏸️ **Partial**

| When | What | Status |
| ---- | ---- | ------ |
| **Now** | GenesisSky dome (DCL textures + cloud scroll) | ✅ `DclGenesisSky` |
| **Now** | Purple night sky, moon, stars, moon fill light | ✅ `moonLightIntensity()` + night hemi; user **Moon Light** / **Moon Exposure** sliders (2026-06-18) |
| **Now** | `SkyboxTime` ECS on RootEntity + `scene.json` fixedTime | ✅ mirror + smooth transition |
| **Now** | World `/about` + `display.skybox` custom textures | ✅ cubemap / equirect when provided |
| **Now** | Animated water plane under landscape | ✅ `WaterPlane.ts` — 1024 m+ ocean, no square horizon clip |
| **Now** | Skybox default midday (12:00) on load | ✅ `MIDDAY_SECONDS = 43200` |
| **Now** | DCL cubemap clouds (near/far/horizon/top) | ✅ white midday puffs — HDR tint + screen blend (2026-06-18) |
| **Now** | FPV camera zoom (scroll to first person) | ✅ 1.82 m eye height, inverted pitch, hide body + tag |
| **Now** | Sun directional brightness | ✅ `SUN_BRIGHTNESS = 1.55` + user **Scene Sun Light** slider |
| **Now** | Sun shadow sweep disabled | ✅ no moving diagonal ground shadow from sun cycle |
| **Now** | `LightSource` ECS + `LightManager` culling | ✅ intensity/range/spot + 40 m cull + quality tiers — **FPS win in Genesis Plaza** |
| **Now** | PhysX player grounding + capsule debug | ✅ feet on y=0; bone-based pivot; debug panel toggles |
| **Now** | Sun / ECS hybrid + ACES exposure | ✅ hybrid dim + tier exposure; user day/night exposure sliders |
| **Now** | Scene GLTF neon / LED emissives | 🟡 DCL color×intensity split — warm LEDs at night; not full Explorer parity |
| **Now** | Preferences → Graphics lighting UI | 🟡 4 live sliders + stub sections (MSAA, bloom, etc.) |
| **Pre-live** | Emote GLB props | ✅ `SkeletonUtils.clone` + scene-emote URNs (2026-06-13) |
| Full Explorer ShaderGraph parity (bloom, dual sun logo) | ⬜ polish |
| Per-layer cloud tint gradients (Explorer Far/Near) | ⬜ single global `uCloudsColor` today |
| **Phase 6** | Post-processing, probe env maps | ⬜ deferred |

Default sky time: **midday (12:00)** on load. Day/night cycle still available when `SkyboxTime` is not fixed — **60 DCL-seconds per real second** (24-minute full cycle).

---

## Phase 3a — Environment & skybox ✅ **CLOSED**

| Task | Status |
|------|--------|
| Procedural skydome (DCL GenesisSky shader port) | ✅ |
| Sun + moon directional lights + hemisphere ambient | ✅ ramps from `SkyboxRenderController` |
| Sun/moon paths from `SunCycle24h.anim` quaternions | ✅ `sunCycle24h.ts` + slerp sampler |
| Fog + background color synced to sky | ✅ |
| DCL day/night cycle (24 min) | ✅ when no `SkyboxTime` on RootEntity |
| `SkyboxTime` mirror + smooth transition | ✅ forward/backward `TransitionMode` |
| `scene.json` `skyboxConfig.fixedTime` | ✅ parsed from entity metadata |
| World `/about` `configurations.skybox.textures` | ✅ optional cubemap / panorama |
| `display.skybox` / `skyboxTexture` in scene metadata | ✅ resolved via content manifest |

---

## Client chrome (Explorer sidebar) ✅ **CLOSED**

| Task | Status |
|------|--------|
| Left vertical panel 2% width | ✅ `#client-shell` |
| Skybox NIGHT/DAY popup (auto + custom slider 0–23:59) | ✅ anchors to skybox button |
| Top stack: profile, notifications, credits, events, map, … | ✅ profile face from Catalyst |
| Circular minimap (top-left, 224×224) | ✅ scene parcels only + player dot |
| **World location card** (replaces minimap in worlds) | ✅ `WorldLocationCard.ts` — name, live coords, **Jump back to Genesis City** → `0,0` |
| Debug panel (right-anchored, hidden by default) | ✅ toggled from Help icon; live scene-local + world position HUD |
| Settings overlay (tabbed) | ✅ Events, Places, Communities, Map, Backpack, Gallery |
| **Preferences panel (P / ⚙)** | ✅ Graphics live · **Sounds partial** (volume + mic UI) · Controls/Chat stubs |
| **Dev progress panel** | ✅ `</>` sidebar — TASKS.yaml + PROGRESS.md from GitHub + integration registry |
| **Map tab** — Genesis City stitched tiles | ✅ click mini-map / **M** — parcel popup + Jump In + peer sidebar (dcl-neurolink parity) |
| **Events tab** — calendar + weekly views | ✅ DCL Events API · Weekly (4 day columns) / Calendar toggle · Today + Create Event stub |
| Chat sidebar unread badge | ✅ count when panel closed; clears on open |
| Emote wheel (B key) | ✅ SVG radial menu — `EmoteWheelPanel.ts` |
| Backpack view | ✅ avatar preview, equipped thumbnails, inventory grid, item detail |
| Scene compass overlay | ⬜ removed — minimap replaces it |

---

## Source layout (current)

```
src/
├── main.ts
├── client/
│   ├── bootstrap.ts
│   └── ui/
│       ├── Minimap.ts
│       ├── WorldLocationCard.ts
│       ├── DebugPanel.ts
│       ├── EmoteWheelPanel.ts
│       ├── NameTag.ts
│       ├── NameTagRenderer.ts
│       ├── RenderStats.ts
│       └── shell/          ClientShell, SidebarButton, SkyboxPanel, SettingsOverlay, BackpackView
├── core/
│   ├── World.ts
│   └── systems/
│       ├── LandscapeSystem.ts
│       └── SceneScriptSystem.ts
├── dcl/
│   ├── content/          route, resolveScene, parseParcel, types
│   ├── ecs/registry.ts   component → phase map
│   └── landscape/        …
├── physics/              loadPhysX, PhysXWorld, Layers, vendor/
├── player/
│   ├── PlayerSystem.ts   capsule, camera, velocity rotation
│   ├── PlayerInput.ts
│   └── locomotion.ts     walk/jog/run, mirror settings
├── avatar/
│   ├── AvatarComposer.ts, LocalAvatar.ts, SceneAvatar.ts
│   ├── AvatarAnimations.ts, avatarShapeProfile.ts
│   ├── headAnchor.ts, displayName.ts
│   ├── peerApi.ts, slots.ts, bodyShape.ts, face.ts, materials.ts
│   └── constants.ts, types.ts
├── environment/
│   ├── EnvironmentSystem.ts, DclGenesisSky.ts, WaterPlane.ts
│   ├── sunCycle24h.ts, sunCycleSampler.ts, skyboxTime.ts
├── bridge/
│   ├── CrdtMirror.ts, ThreeBridge.ts, AvatarShapeBridge.ts
│   ├── dclTransform.ts, ReservedEntitiesSync.ts, mirrorComponents.ts
│   └── material/, primitiveShapes.ts
├── input/                PointerEventsSystem, PointerHoverFeedback, PointerHighlightFeedback, pointerConstants, inputActionBinding
├── shim/                 sceneWorker, system stubs, types
└── rendering/            SceneHost, AssetCache, DclTextureResolver, …
```

---

## Decoration profile (padding parcels)


| Prop   | Count per padding parcel |
| ------ | ------------------------ |
| Trees  | 0–1 (tree01 + tree02)    |
| Bushes | 3–6                      |
| Rocks  | 0–2                      |
| Grass  | 8–14                     |


Scene footprint parcels: **ground only** (no scatter).

---

## Phase 2a — PhysX player + DCL camera ✅ **CLOSED**


| Task                                           | Status                                                |
| ---------------------------------------------- | ----------------------------------------------------- |
| PhysX WASM loader (Hyperfy port)               | ✅ lazy dynamic import — not at page startup           |
| `PhysXWorld` — static colliders + capsule      | ✅ scene `MeshCollider` + GLTF `_collider` trimesh  |
| GLTF collider → PhysX trimesh                  | ✅ per-instance cook (no shared-cache bug); degenerate meshes skipped |
| PhysX WASM memory API                          | ✅ `_webidl_malloc` / `_webidl_free`                   |
| `PlayerSystem` — WASD, DCL walk/jog/run/jump | ✅ Ctrl walk · Shift run · Space / double jump |
| DCL-style third-person camera                  | ✅ lock/unlock, 360° orbit, pitch 0→top-down, scroll zoom |
| FPV (scroll to min distance)                   | ✅ eye height 1.82 m, inverted look Y, body hidden         |
| Landscape ground physics                       | ✅ thin box per parcel so player does not fall through |
| Player feet snap / ground sweep                | ✅ Hyperfy 0.22 m sweep + `stickFeetToGround` — local player no longer floats |
| PhysX collider debug (Help panel)              | ✅ flat toggles — MeshCollider / GLTF / local capsule wireframes |
| Padding parcel outer wall colliders            | ✅ 500 m tall thin boxes on outside edges of empty padding parcels |
| Scene `MeshCollider` → PhysX sync              | ✅ `CollisionSystem.getPhysicsColliders()`             |


**Controls (DCL desktop):** WASD move · **Ctrl** walk · **Shift** run · default jog · **Space** jump · **Space** in air double jump · click lock · Tab/right-click/Esc unlock · scroll zoom

---

## Phase 2c — Reserved ECS entities ✅ **CLOSED**


| Task | Status |
|------|--------|
| `RootEntity` (0) transform at scene origin | ✅ mirror seed + CRDT getState |
| `PlayerEntity` (1) client-owned transform | ✅ `ReservedEntitiesSync` ← PhysX capsule |
| `PlayerEntity` identity for `getPlayer()` | ✅ `PlayerIdentityData` + `AvatarBase` + `AvatarEquippedData` on mirror CRDT |
| `CameraEntity` (2) client-owned transform | ✅ synced from active Three.js camera |
| `MainCamera` on CameraEntity | ✅ registered in mirror |
| CRDT round-trip on scene sync | ✅ player/camera pushed before each `crdt-send` response |
| `movePlayerTo` / parcel clamp | ✅ Phase 2b — worker RPC + bounds clamp |

SDK7 reserved IDs: `RootEntity=0`, `PlayerEntity=1`, `CameraEntity=2`. Scene entities still parent to `RootEntity`; ThreeBridge skips rendering the reserved trio.

---

## Phase 1 — ECS shim + scene.js ✅ **CLOSED**


| Task                                                        | Status                                                         |
| ----------------------------------------------------------- | -------------------------------------------------------------- |
| ECS component registry + docs                               | ✅ `[INTEGRATION.md](./INTEGRATION.md)`, `registry.ts`    |
| `CrdtMirror` (@dcl/ecs renderer transport)                  | ✅ stable @ 120fps on RickRoll                                 |
| `sceneWorker` + ~system stubs                               | ✅ `onStart` + `onUpdate` loop; see **no-ops** below            |
| `ThreeBridge` — Transform hierarchy + parent order          | ✅ `dclTransform.ts` — depth-sorted parents + LH→RH conversion   |
| `ThreeBridge` — MeshRenderer primitives                     | ✅ box/sphere/cylinder/plane — **plane vertical + double-sided**; **box/plane custom `uvs`** |
| `ThreeBridge` — Material (PBR/unlit, textures, alpha)     | ✅ `MaterialApplier.ts`                                        |
| `ThreeBridge` — GltfContainer, Visibility                   | ✅ reload on src change — all GLTF scenes (Plaza, RickRoll, parcels) |
| Phase 1b — `LightSource`, `TextShape`                       | ✅ `LightSourceSync.ts` + `LightManager` culling + quality tiers |
| Phase 1b — `Billboard`, `Animator`                          | ✅ `BillboardBridge.ts`, `AnimatorBridge.ts` in `SceneScriptSystem` |
| `SceneScriptSystem` wired in `World`                        | ✅                                                              |
| RickRoll `/rickroll.dcl.eth` validation                     | ✅ scene script + CRDT + meshes confirmed                       |


**Architecture:** Scene bundle runs in worker → CRDT RPC → main-thread mirror engine → ThreeBridge.

### Phase 1 fidelity fixes (2026-06-12 evening)

| Fix | Status | Notes |
|-----|--------|-------|
| Transform parent-before-local apply | ✅ | `sortEntitiesByTransformDepth` + `applyDclLocalTransform` |
| Plane orientation | ✅ | Removed erroneous `rotateX(-π/2)` — matches DCL `CreatePlane` (vertical XY) |
| Plane double-sided rendering | ✅ | `THREE.DoubleSide` — matches DCL `sideOrientation: 2` |
| AvatarShape NPC facing | ✅ | Removed fixed `AVATAR_YAW_OFFSET` on `SceneAvatar` — ECS Transform drives facing |
| Local player yaw offset | ✅ | `LocalAvatar` still uses `AVATAR_YAW_OFFSET` for locomotion |

### Phase 1 fidelity fixes (2026-06-12 late night) — **Explorer parity**

| Fix | Status | Notes |
|-----|--------|-------|
| Full-scene X mirror vs Explorer | ✅ | DCL LH → Three RH: negate X on position; quat `(-x,y,z,-w)` |
| Player / landscape / remote avatars | ✅ | Same conversion at every visual boundary |
| CRDT + comms stay in DCL space | ✅ | `threeToDcl*` on mirror write + movement broadcast |

---

## Phase 2b — Player APIs ✅ **CLOSED**

| Task | Status |
|------|--------|
| Scene spawn from `scene.json` metadata | ✅ `pickSpawn()` → `PlayerSystem.init()` |
| Spawn `cameraTarget` → initial look yaw/pitch | ✅ `applyLookTarget()` |
| Parcel boundary clamp (soft wall) | ✅ `SceneBounds` + post-physics teleport |
| `RestrictedActions.movePlayerTo` | ✅ worker ↔ main RPC; instant + interpolated |
| Player spawns before scene script | ✅ `prepare()` then player, then worker boot |

---

## Phase 5 — Social comms 🟡 **IN PROGRESS**

| Task | Status |
|------|--------|
| Splash login screen | ✅ **Connect Wallet** only (+ returning-user jump-in); guest via `?guest` / `?skipLogin` |
| `@dcl/crypto` AuthIdentity + localStorage | ✅ `AuthClient` + `identityStore` |
| `SessionIdentity` — Catalyst profile connect | ✅ post-login profile fetch |
| `CommsService` + RFC4 room client | ✅ `setCommunicationsAdapter` worker bridge |
| Bevy-shaped comms plugin + Scene routing | ✅ archipelago path scaffold |
| Movement wire codec (Bevy/Unity alignment) | ✅ genesis/world DCL coords outbound; inbound → scene-local |
| `RemoteAvatarManager` transform sync | ✅ blank placeholder → profile + lerp (display coords converted) |
| `CommunicationsController` / `UserIdentity` stubs | ✅ worker ↔ main RPC |
| **Peer visibility — two clients same scene** | ✅ confirmed working |
| Scene chat UI + RFC4 encode/decode | ✅ ChatPanel + LiveKit reliable chat publish |
| Chat UX (140 char, links, @mentions, `/goto` styling) | ✅ `chatMentions.ts`, `linkifyText.ts`, `chatNavigationLinks.ts` — nav links teleport in-client |
| **Scene chat outbound (LiveKit)** | ✅ dcl-companion wire + fan-out scene/world/island |
| **Scene chat timestamps in Unity Explorer** | ⬜ **known gap** — wire uses session-elapsed (companion path); **Three.js UI shows correct local time**; Explorer shows wrong date until Unity-header + unix chat encode is verified on wire |
| Scene-mode rail transparency | ✅ rail hidden in scene mode until hover/pin |
| Member communities rail (Signed Social API) | ✅ `fetchMemberCommunitiesSigned` |
| Session identity expiry in localStorage | ✅ `identityStore` + splash expiry hint |
| Avatar spawn after social/comms load | ✅ `initCapsule` → comms → social → `loadAvatar` |
| Profile on join + remote avatar parity | ⬜ |
| Community text (PM router / LiveKit pool) | ⬜ stub — local echo only |
| Voice / presence (LiveKit / realm adapter) | ⬜ |
| Gatekeeper / signed-login (realm-dependent) | ⬜ |
| Direct messages channel | ⬜ placeholder in rail |

---

## Phase 4a — DCL avatar compose ✅ **CLOSED**


| Task | Status |
|------|--------|
| Catalyst profile + wearable fetch | ✅ `peerApi.ts` — peer-ec2, collections-v2 URN strip |
| ADR-239 slot resolution | ✅ `slots.ts` |
| Body shape + wearables GLB load | ✅ skeleton rebind + merge fallback |
| Attach to player capsule | ✅ `LocalAvatar` on `PlayerSystem` root |
| Profile wallet persistence | ✅ `?profile=0x…` + `localStorage` address |
| Full avatar cache (URN fingerprint) | ✅ `profileStorage.ts` — wearables + profile blob |

---

## Phase 4b — Avatar polish ✅ **CLOSED**


| Task | Status |
|------|--------|
| Base mesh hiding (Forge `body.ts`) | ✅ category + hides/replaces + hands |
| Wearable emissives (visor, neon trim) | ✅ Forge 4× factor + intensity 12 — tune in `constants.ts` |
| Idle + walk emote animations | ✅ DCL `idle.glb` / `walk.glb` on Avatar_ rig |
| Facial features (eyes/eyebrows/mouth) | ✅ `face.ts` — texture + mask emissive |
| Smooth third-person rotation | ✅ velocity-facing + exp lerp (no camera-lock skating) |
| `AvatarShape` ECS mirror + scene compose | ✅ `AvatarShapeBridge` — NPC entities; local player stays profile URL |
| Avatar name tags | ✅ CSS2D pill labels — head-tracked, profile name + nameColor |
| Emissive 1:1 parity (Explorer bloom) | ⬜ deferred — needs post-process bloom pass |

---

## Phase 4c — Locomotion emotes ✅ **CLOSED**


| Task | Status |
|------|--------|
| Run emote (Shift sprint) | ✅ DCL `run.glb` at run speed |
| Jump + double jump emotes | ✅ First jump `jump.glb` loop · second jump one-shot twirl (1.35×) + spin puff |
| Locomotion VFX puffs | ✅ `AvatarLocomotionVfx` — foot dust (walk/jog/run cadence) + air-jump burst |
| Air-jump delay | ✅ 0.2s hold before second impulse (Explorer `AirJumpDelay`) |
| DCL speed defaults | ✅ walk 1.5 · jog 8 · run 10 m/s — `AvatarLocomotionSettings` from scene |
| Velocity-based avatar rotation | ✅ smooth facing; no strafe skating |
| Glider | ⬜ skipped |
| Fall pose | ✅ idle while airborne (no Avatar_ fall clip in catalog) |
| Directional walk/jog GLBs | ⬜ deferred — Mixamo rig; rotate-to-move instead |
| Profile emote playback | ✅ wheel + `triggerEmote` — bundled defaults + Catalyst fallback; remote RFC4 `PlayerEmote` |

---

## Shipped this session (2026-06-13 — late evening)

**Assets / rendering**
- **Session GLB cache** — `getSessionAssetCache()` singleton per tab; survives parcel/world teleports; `disposeSessionAssetCache()` on sign-out only — `AssetCache.ts`, `World.ts`
- **SkinnedMesh scene GLTF clone** — `SkeletonUtils.clone()` in `cloneGltfInstance()` — fixes frustum-cull crashes + broken skinned instances (RickRoll dancers, emote props) — `skinnedMeshInstance.ts`

**Environment / worlds / chat / login**
- **Moon fill at night** — moon directional decoupled from sun anim curve; boosted `MOON_BRIGHTNESS`, night hemi + ground bounce, dynamic exposure; midnight quaternion wrap fix — avatars readable at 23:59
- **World location card** — in worlds hide minimap; show world name, live floor coords, **Jump back to Genesis City** (teleport `0,0`); card width −10%
- **Chat UX** — 140 char cap; blue URL links; `/goto` input styling; @-mention autocomplete (scene peers from gatekeeper + LiveKit)
- **Chat nav links** — parcel coords (`80,-1`), `.dcl.eth` names, Decentraland play URLs → in-client teleport (not new tab) — `chatNavigationLinks.ts`, `linkifyText.ts`
- **Chat @mention highlight** — purple `is-mentioned` on **bubble only** (not whole row) when message @-mentions local user — `chatMentionDetection.ts`, `ChatPanel.ts`
- **Login** — removed **Sign in with Decentraland** (auth-server popup); wallet connect remains primary path
- **Dev progress panel** — `</>` sidebar → Roadmap (`TASKS.yaml`), Integration status, and Progress (`PROGRESS.md`) fetched live from `lastraum/dcl-threejs-client` `main` — `DevProgressPanel.ts`, `githubDocs.ts`. Offline: `?docsGithubFetch=0` uses bundled snapshots; **`npm run prebuild`** → `sync-dev-progress.mjs` regenerates `tasksFallback.ts` + `progressFallback.ts` from local `docs/`.

**ECS bridges**
- **`TweenBridge`** — wired in `SceneScriptSystem` + `mirrorComponents` (`Tween`, `TweenState`); move/rotate/scale/moveRotateScale + continuous modes; 31 easing curves; writes `TweenState` for worker `tweenCompleted()` — see **Tween status** below

**PointerEvents (2026-06-14)**
- **Hover tooltips** — scene `hoverText` + DCL button icons (E, F, mouse, 1–4, Spc, Ctrl) — `PointerHoverFeedback.ts`, `inputActionBinding.ts`
- **Mesh highlight** — green/red outline from `showHighlight` + per-entry distance — `PointerHighlightFeedback.ts`
- **Input actions** — `IA_POINTER` left click · `IA_PRIMARY` E only · `IA_SECONDARY` F · `IA_ACTION_3`–`IA_ACTION_6` (1–4) · `IA_JUMP` Space · `IA_WALK` Ctrl — `PointerEventsSystem.ts`
- **Distance** — camera `maxDistance` first, then player fallback (same entry’s fields only)
- **Scene logs** — worker `console.*` → client debug log — `sceneWorker.ts`, `SceneScriptSystem.ts`

**Next:** voice / LiveKit audio · `UiTransform` · `TriggerArea` · parcel routes

---

## Tween status — ✅ **WORKING** (2026-06-14)

**Do we have tweens?** **YES** — transform + texture UV interpolation + **`TweenSequence` loop** validated on Genesis Plaza blimp orbit.

| Layer | File | Status |
| ----- | ---- | ------ |
| Renderer bridge | `src/bridge/TweenBridge.ts` | ✅ move, rotate, scale, moveRotateScale, moveContinuous, rotateContinuous, **textureMove**, **textureMoveContinuous** |
| Wiring | `SceneScriptSystem.ts` — `pumpMotionBridges()` on sync frame + hydration ticks | ✅ (fixes async-busy skip that froze tweens in heavy scenes) |
| Mirror CRDT | `mirrorComponents.ts` — `Tween` (1102), `TweenState` (1103), **`TweenSequence` (1104)** | ✅ |
| Registry | `dcl/ecs/registry.ts` | ✅ Tween render · TweenState client-only · **TweenSequence render** |
| Scene worker | `@dcl/ecs` `createTweenSystem()` — `tweenCompleted()`, sequence/yoyo | ✅ runs in worker; depends on `TweenState` round-trip |

**Implemented vs Unity / DCL Explorer**

| Feature | Client | Notes |
| ------- | ------ | ----- |
| Move / rotate / scale tweens | ✅ | Lerp + slerp on `Transform`; `faceDirection` on move |
| `moveRotateScale` combined | ✅ | Single eased progress |
| Continuous move / rotate | ✅ | Speed × delta while `playing` |
| **`textureMove` / `textureMoveContinuous`** | ✅ | UV offset/tiling on `map` / `emissiveMap` / `alphaMap` — **GLTF + MeshRenderer** |
| Easing (31 `EasingFunction` values) | ✅ | `@tweenjs/tween.js` mapping |
| Pause (`playing: false`) | ✅ | `TweenState.state = 2` |
| `TweenState` + `currentTime` write-back | ✅ | Mirror → worker CRDT for `tweenCompleted()` |
| **`TweenSequence` loop (RESTART / YOYO)** | ✅ | Genesis Plaza blimp — 90s rotate orbit via scene script |
| Progress reset on target change | ✅ | Signature includes mode payload; `justReset` on change |
| Material UV animation parity | ✅ | MeshRenderer custom shape UVs + Material offset/tiling; tweens no longer reset each frame |

**QA reference:** Genesis `0,0` blimp (`blimp.glb`) — rotate `Tween` + `TweenSequence` on pivot entity (`hO = 90000` ms full orbit). Loading screen shows **hydration elapsed timer** (count-up from 0:00; timeout at 3:00 default, 1:30 on teleport; orange at timeout; green on ready).

---

## Shipped this session (2026-06-14)

**Scene hydration / loading**
- **Count-up elapsed timer** — loading screen ticks from 0:00 (replaces countdown); final time shown on ready or timeout fallback
- **Attach stall + hard timeout** — 20s stall detector + 180s backstop; `gltfAbandoned` excluded from gate; skip 5s post-load hold on timeout
- **Attach throughput** — hydration multi-pass burst, priority queue, budget only on successful attach; failed GLBs not cached as empty placeholders

**Remote avatars**
- **Wearable texture resolver** — merge all wearable mappings at compose time; `.png` ↔ `.png.png` aliasing; Catalyst leaf-name lookup — fixes `Avatar_*SkinBase` / `Image_0.png` 404 spam

**Files:** `sceneHydration.ts`, `LoadingScreen.ts`, `ThreeBridge.ts`, `AssetCache.ts`, `DclTextureResolver.ts`, `AvatarComposer.ts`, `loadWearable.ts`, `peerApi.ts`

---

## Shipped this session (2026-06-13 — afternoon / evening)

**PhysX + lighting**
- Local player grounding: spawn Y=0, 0.22 m ground sweep, feet snap — matches NPCs/remotes on y=0 floor
- Bone-based avatar pivot (`feetAlign.ts`) — capsule debug pill aligns with body
- PhysX debug panel: flat MeshCollider / GLTF / capsule toggles (removed broken master gate)
- `LightSource` quick wins + `LightManager` (40 m cull, tier 4/6/10, shadow cap flags)
- Intensity `/4000` restored after overexposure regression — **Genesis Plaza FPS hugely improved**

**Map + events + chat UI**
- Full Genesis map in settings (tiles from genesis.city, peer markers, parcel popup, Jump In)
- Events tab: DCL Events API, Weekly/Calendar views, highlight panel, 4 scrollable day columns
- Chat sidebar unread badge when panel closed
- Orbit: left-drag orbits without toggling pointer lock; right-click / Esc toggle capture
- AvatarShape emotes: trigger detection fix + loop until `expressionTriggerId` cleared

**Docs**
- [`lightsource-parity.md`](./lightsource-parity.md) — implemented vs outstanding Explorer gaps

---

## Shipped this session (2026-06-13 — morning)

**Profile emotes (Phase 4d — expanded)**
- **Bundled defaults:** 15 profile emotes + idle/walk/run/jump in `public/avatar/emotes/` (Forge + Catalyst fetch); `profileEmotes.ts` prefers local paths, Catalyst `base-emotes` fallback
- **Profile-owned emotes:** Lambda `avatar.emotes[]` slots 0–9 parsed in `peerApi.ts`; wheel shows equipped URNs via `buildEmoteWheelSlots(profile)`
- **Local playback:** wheel / `triggerEmote` → `World.playLocalEmote` → resolve + `AssetCache` → `AvatarAnimations.playProfileEmote`; WASD/jump cancels emote
- **Remote sync:** outbound RFC4 `PlayerEmote` (`encodeRfc4PlayerEmotePacket`) on scene/world/island LiveKit rooms; inbound `Rfc4Router` → `RemoteAvatarManager.playPeerEmote` — **no separate subscribe API** (Unity parity)
- Emote wheel wedge styling — gray segments (was dark purple)

**Profile emotes (Phase 4d — initial)**
- Emote wheel (B / sidebar) → `World.playLocalEmote` → `LocalAvatar.playEmote`
- `AvatarAnimations.playProfileEmote` — one-shot override, returns to idle/walk on `finished`
- `RestrictedActions.triggerEmote` stub wired (worker RPC → same playback path; respects Catalyst `loop` flag)

**Deferred: third-person camera jitter**
- **Root cause (user-confirmed):** orbital / third-person camera lerp near **alpha-tested tree foliage** — not sync-frame physics or LOD
- **FPV has hardly any stutter** — fix deferred; tune camera smoothing vs alpha foliage draw order / depth prepass later

**Collision / physics**
- GLTF collider extraction: hide `/_collider/i` meshes in sanitizer (not delete) — geometry kept for PhysX
- Ported Hyperfy `geometryToPxMesh` — `PHYSX.CreateTriangleMesh` with local geometry + shape transforms
- GLTF colliders as simulation + query shapes on static rigidbodies
- Fixed PhysX WASM memory API (`_webidl_malloc` / `_webidl_free`)
- Reverted broken stream-based trimesh cooking; AABB fallback was interim

**Multiplayer / position sync**
- `MovementCompressed` decode: expanded realm bounds + base parcel origin offset for scene-local coords
- Outbound movement: send genesis/world DCL coords on Movement wire (matching Bevy/Unity)
- Inbound Movement converts genesis → scene-local — remote players align with DCL official client
- Local player visible when moving in DCL

**UI**
- Emote wheel (B key, SVG radial menu — `EmoteWheelPanel.ts`)
- Settings overlay with tabs (Events, Places, Communities, Map, Backpack, Gallery, Settings)
- Backpack view: avatar preview, category equipped thumbnails, inventory grid, item detail
- Debug panel: live scene-local + world position HUD above network log

**Performance**
- Lazy-load PhysX WASM via dynamic import (not at page startup)
- `forceContextLoss` on renderer dispose

---

## Shipped this session (2026-06-12)

**Morning / core**
- Reserved entities CRDT sync (Root / Player / Camera + MainCamera)
- DCL locomotion: Ctrl walk, Shift run, double jump, air steering
- AvatarShape ECS → composed NPC avatars in scene
- Name tags: head-tracked CSS2D pills, Catalyst `name` + `nameColor`, verified badge
- Player rotation: velocity-facing with exp lerp

**Evening / fidelity + polish**
- Transform port: parent hierarchy depth sort + direct quaternion mapping
- Plane primitives: vertical orientation + double-sided materials (DJ screen parity ✅)
- AvatarShape NPC facing: ECS Transform drives rotation (no spurious 180° offset)
- 500 m outer wall colliders on padding parcel edges
- Water shader plane + ocean-toned fog (no cyan void)
- Skybox defaults to midday; sun ground shadow sweep removed
- Minimap (top-left), debug panel (Help toggle, right side), compass removed

**Late evening / Explorer parity pass**
- DCL cubemap clouds: near, far, horizon, top layers from unity-explorer assets
- FPV zoom: scroll to first person, eye-height camera, local avatar hidden
- Name tags: head offset tuned (2.14 m above bone)
- Water plane expanded to 1024 m+ (no visible square edge at horizon)
- Minimap shows **scene parcels only** (no padding ring)

**Night / camera + tuning**
- FPV eye height raised to 1.82 m; pitch inverted in first person
- Sun +20% brighter (`SUN_BRIGHTNESS`)
- ECS_COMPONENTS.md + `registry.ts` synced to actual implementation status

**Late night / Explorer parity + comms prep**
- **Fixed full-scene X mirror** — `dclTransform.ts` LH→RH at render boundary; confirmed vs Unity Explorer on RickRoll
- Player, landscape, water, PhysX ground, remote avatars, CRDT mirror boundaries updated
- RFC4 movement codec aligned to Bevy inbound / Unity outbound (position, velocity Z, yaw degrees)
- Comms plugin refactor (Bevy-shaped architecture, Scene packet routing, LiveKit session scaffold)

---

## Phase 3b — PointerEvents ✅ **CLOSED** (2026-06-14)

Unity Explorer splits this into **four pieces** — we combine the raycast + result writer into one class (no separate ECS system module needed on the renderer):

| Unity (legacy renderer) | ThreejsClient |
| --- | --- |
| `PointerEventsHandler` — PB → internal component | Scene worker `@dcl/ecs` `pointerEventsSystem` writes `PointerEvents` CRDT |
| `OnPointerEventColliders` — mesh colliders on pointer layer | `PointerEventsSystem.collectPointerTargets()` — glTF `_collider`, `MeshCollider`, **MeshRenderer** primitives |
| `PointerEventsController` — physics ray → `lastPointerRayHit` | `THREE.Raycaster` from camera + mouse NDC (center when pointer-locked) |
| `ECSPointerInputSystem` — hover/down/up → `PointerEventsResult` | Same class writes grow-only `PointerEventsResult` + `PrimaryPointerInfo` on mirror → CRDT round-trip |
| `IECSInteractionHoverCanvas` — button icon + hover text | `PointerHoverFeedback.ts` + `inputActionBinding.ts` |

| Task | Status |
| --- | --- |
| Mirror register `PointerEvents`, `PointerEventsResult`, `PrimaryPointerInfo` | ✅ `mirrorComponents.ts` |
| Camera raycast + priority + distance (per-entry `maxDistance` / `maxPlayerDistance`) | ✅ `PointerEventsSystem.ts` |
| Hover enter/leave + pointer down/up (CRDT on `crdt-send`) | ✅ |
| Hover tooltips (`showFeedback` + `hoverText` + button icons) | ✅ `PointerHoverFeedback.ts` |
| Mesh highlight (`showHighlight` green/red in/out of range) | ✅ `PointerHighlightFeedback.ts` |
| Input actions — click, E, F, 1–4, Space, Ctrl | ✅ `inputActionBinding.ts` |
| Scene worker `console.log` → client debug | ✅ `sceneWorker.ts` |
| Frame loop wiring | ✅ `World.ts` + `SceneScriptSystem.ts` |
| CRDT back to scene worker | ✅ via existing `crdt-send` round-trip |
| Manual QA (custom scenes + Genesis interactives) | ✅ 2026-06-14 |

**Not yet:** proximity events (`PET_PROXIMITY_*`), UI entity pointers.

---

## Phase 3c — EngineApi event queue ✅ **CLOSED** (2026-06-14)

SDK7 scenes call `EngineApi.subscribe("comms")` then drain via `sendBatch` inside `pollEvents()` each frame. That is the **only** sendBatch path `@dcl/sdk` uses today.

| Task | Status |
| --- | --- |
| Worker `subscribe` / `unsubscribe` + subscription set | ✅ `EngineApiEventState.ts` |
| Worker `sendBatch` → `drainEvents()` | ✅ `createSystemStubs.ts` |
| Main-thread bridge (subscription sync + enqueue) | ✅ `EngineApiEventBridge.ts` + `SceneScriptSystem.ts` |
| Inbound LiveKit topic `comms` → queue | ✅ `World.ts` → `pushCommsMessage` |
| Outbound `CommunicationsController.send` | ✅ worker RPC → `publishTopicData('comms', …)` |
| **Tags** mirror CRDT | ✅ `mirrorComponents.ts` + full `getState` dump |

**Pending (out of SDK7 sendBatch scope):**

| Item | Status | Notes |
| ---- | ------ | ----- |
| **`videoEvent`** observable / sendBatch | 🟢 **VideoEvent outbound** | Grow-only append to worker; SDK `videoEventsSystem` callbacks — **`getActiveVideoStreams`** still pending |
| Legacy typed events (`position_changed`, etc.) | ⬜ not planned | SDK7 uses ECS transforms, not sendBatch |
| Other LiveKit topics via sendBatch | ⬜ not planned | Use **`CommsApi.subscribeToTopic` + `consumeMessages`** |

**Tags ✅:** `Tags` registered on CRDT mirror; `getEntitiesByTag()` works in scene worker.

---

## Phase 3 — Backlog (remaining)

| Phase | Focus | Status |
| ----- | ----- | ------ |
| **3** | UI (`UiTransform`…), Raycast, TriggerArea, video/audio | ⬜ next |
| **3a** | Skybox + SkyboxTime + environment | ✅ closed |
| **3b** | `PointerEvents` + camera raycast | ✅ closed |
| **3c** | `EngineApi` sendBatch + comms observables | ✅ closed |
| **4d** | Profile emotes + ECS bridges | ✅ emotes + VFX · **`AvatarEmoteCommand` ✅** · **`Tween` ✅** (transform + textureMove + TweenSequence) |
| **4e** | Remote players — sync transforms + avatars | 🟡 display layer ready |
| **5** | Social comms (multiplayer + voice/presence) | 🟡 active |
| **6** | Parcel streaming, LOD, instancing, env cycles | ⬜ |

---

## What's next (recommended order)

**Pre-live blockers — cleared ✅ (2026-06-13).** Optional polish before / after push:

| Priority | Task | Why |
| -------- | ---- | --- |
| 1 | **3** | **`Raycast` + `TriggerArea`** | Scene ray APIs + volume enter/exit — unlocks many interactives |
| 2 | **3b** | **`PET_PROXIMITY_*`** pointer events | Walk-up interactives (no cursor) |
| 3 | **3** | ~~**`VideoPlayer` + `videoEvent`**~~ ✅ | RickRoll screen parity — remaining: **`getActiveVideoStreams`** comms stub |
| 3b | **3** | ~~**`AudioSource` + `AudioStream`**~~ ⬜ | Code shipped — **user test pending**; wire voice/UI/emote volume prefs |
| 4 | **5** | Voice / presence (LiveKit audio) | Social layer — hook **Voice Chat & Streams** slider + mic picker |
| 5 | **3** | `UiTransform` MVP | In-world UI |
| 6 | infra | Parcel routing `/80,-1` → Catalyst | Genesis City parcel scenes |

---

## ~system stubs — intentional no-ops (revisit)

Tracked in `src/shim/system/createSystemStubs.ts`. These are **deliberately stubbed** so scenes can boot; replace when the matching client feature exists.

| Stub | Module | Current behavior | Why it matters / when to implement |
| ---- | ------ | ---------------- | ----------------------------------- |
| **`sendBatch`** | `~system/EngineApi` | ✅ **drains queued events** | Worker `EngineApiEventState.drainEvents()`; main enqueues via `engine-api-enqueue`. SDK `pollEvents(sendBatch)` each frame. |
| **`subscribe` / `unsubscribe`** | `~system/EngineApi` | ✅ **tracks event ids** | Worker subscription set synced to main (`EngineApiEventBridge`). Inbound **`comms`** topic wired. |
| **`send`** | `~system/CommunicationsController` | ✅ **publish topic `comms`** | Worker RPC → main `CommsService.publishTopicData`. Pairs with inbound → `sendBatch` for `onCommsMessage`. |
| **`triggerEmote`** | `~system/RestrictedActions` | ✅ worker RPC → local playback + RFC4 broadcast | Scene-triggered emotes (`predefinedEmote` id or URN). |
| **`openExternalUrl`** | `~system/RestrictedActions` | ✅ worker RPC → `window.open` (http/https) | Popup blockers return `{ success: false }`. No confirmation dialog yet. |
| **`openNftDialog`** | `~system/RestrictedActions` | ⬜ **no-op** | NFT detail modal — deferred. |
| **`getActiveVideoStreams`** | `~system/CommsApi` | ⬜ **no-op** — `{ streams: [] }` | **Pending** — pairs with **`VideoPlayer` + `videoEvent`** observable |

**Recently unblocked (not no-ops):**

| API | Status | Notes |
| --- | ------ | ----- |
| `getPlayer()` (SDK `@dcl/sdk/players`) | ✅ | Reads ECS on `PlayerEntity`; mirror now syncs identity components before worker `crdtGetState`. Fixes Genesis Plaza `UserData not set` crash. |
| `UserIdentity.getUserData` | ✅ RPC | Worker ↔ main via session profile; guest synthetic id. Scenes should prefer `getPlayer()`. |
| `CommunicationsController.sendBinary` | ✅ | Comms room + scene binary delivery wired. |
| `CommunicationsController.send` | ✅ | Legacy string message bus — topic `comms` publish + inbound → `sendBatch`. |
| `EngineApi.sendBatch` + `subscribe` | ✅ | SDK7 **`comms`** only — see Phase 3c |
| `RestrictedActions.movePlayerTo` | ✅ | Worker RPC + parcel clamp. |
| `RestrictedActions.openExternalUrl` | ✅ | Worker RPC → main thread `window.open` (http/https). |
| `SignedFetch` | ✅ | Worker RPC → main thread `decentraland-crypto-fetch`; signed when wallet connected, unsigned fallback for public URLs; `getHeaders` returns ADR-44 auth headers (quests WebSocket). |

**Suggested implementation order for no-ops:** (1) ~~`sendBatch` + `subscribe`~~ ✅, (2) ~~`triggerEmote`~~ ✅, (3) ~~`openExternalUrl`~~ ✅, (4) video streams.

---

## Known gaps / follow-ups

- **Genesis Plaza boot:** `getPlayer()` identity on mirror CRDT — **✅ fixed** (2026-06-12). **`EngineApi.subscribe` + `sendBatch`** — **✅ fixed** (2026-06-14). **`Tags`** — **✅ fixed** (2026-06-14). Remaining: **PET_PROXIMITY** pointers, some UI flows.
- **Scene chat — Explorer timestamps:** Outbound messages deliver (dcl-companion LiveKit encode). Unity Explorer shows **wrong dates** on our messages; Three.js chat UI is correct. Fix deferred: Unity RFC4 header + unix timestamp on wire (currently drops delivery).
- **Interaction:** **`PointerEvents` ✅** — camera raycast, hover icons + tooltips, green/red highlight, full desktop input actions, click/key CRDT to scene worker. Remaining: proximity, UI pointers.
- **GLTF colliders:** **✅ fixed (2026-06-13)** — shared cook cache bug, PhysX release crash, degenerate mesh skip. Genesis plaza blocking confirmed.
- **GltfContainer / Visibility:** **✅** — `ThreeBridge` + `AssetCache`; used on Genesis Plaza, RickRoll, parcel scenes.
- **Profile emotes:** Bundled defaults + wheel + remote RFC4 + AvatarShape loop + **GLB props ✅** + **`AvatarEmoteCommand` ECS bridge ✅** + **locomotion VFX (foot/air puffs) ✅**.
- **Tween:** **`TweenBridge` ✅** — transform + textureMove + **`TweenSequence`** (Genesis blimp orbit) + `pumpMotionBridges` sync-frame fix — see **Tween status** section.
- **Session assets:** GLB/texture cache survives teleports (`getSessionAssetCache`); sign-out evicts via `disposeSessionAssetCache`. **UnityGLTF null-padded JSON chunks** sanitized in `glbSanitizer.ts`. **Hydration gate** — failed GLB loads no longer cached as empty placeholders; loading screen waits for real mesh geometry + unresolved src count; **elapsed timer** (count-up from 0:00; timeout at 3:00 / 1:30 teleport) shows early ready vs fallback.
- **Skinned GLTF instances:** `SkeletonUtils.clone` for scene entities + emote props — `skinnedMeshInstance.ts`.
- **LightSource / sun:** Culling + quality tiers + hybrid sun + ACES + spot shadows + cloud blend ✅ — [`lightsource-parity.md`](./lightsource-parity.md). Remaining: raw candelas, `shadowMaskTexture`, point shadows.
- **PhysX grounding:** Local player feet on ground ✅; **GLTF invisible `_collider` trimesh blocking ✅** (plaza-scale props).
- **GLTF trimesh cooking:** Per-instance uncached cook; failed/degenerate colliders skipped once (no retry spam).
- **Map / Events UI:** Genesis map + Jump In + peer sidebar ✅; Events Weekly/Calendar ✅; chat unread badge ✅.
- **Parcel routes:** `/80,-1` parsing exists; catalyst parcel fetch not wired.
- **Emissive bloom:** Wearable emissives tuned without post-process — deferred for Explorer parity.
- **Explorer tree parity:** Unity uses baked `WorldsTrees.bin`; we use procedural RNG.
- **GPU grass:** Explorer uses `GrassIndirectRenderer`; we scatter grass glTF patches.
- **Environment cycles:** Procedural sky + SkyboxTime done; Explorer 24-texture atlas + bloom deferred.
- **More shared textures:** Add to `DclTextureResolver.ts` as new 404s appear.
- **Visual QA:** Side-by-side layout vs Explorer — **✅ closed** (2026-06-12); position sync aligned with DCL client (2026-06-13).
- **GLTF trimesh cooking:** ~~Stream-based cook reverted; AABB fallback interim — full trimesh cook TBD.~~ **Resolved** — see PhysX grounding above.

---

## Related docs

- `[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)` — full phased architecture
- `[DEPLOYMENT.md](./DEPLOYMENT.md)` — pre-push checklist & browser deployment outline
- `[lightsource-parity.md](./lightsource-parity.md)` — LightSource / sun / shadow tracker
- `[WORLD_ENVIRONMENT.md](./WORLD_ENVIRONMENT.md)` — asset hashes, coords, empty-land catalog


---

## 2026-06-15 — Re-architecture Phase 3 Complete (Projection + Encoder Default)

**Milestone:** The renderer-side CRDT pipeline is now unconditionally driven by `CrdtProjection` (inbound decode + typed state + diff) + `CrdtEncoder` (renderer-owned outbound) + `ProjectionView` (read facade for bridges).

- All `?projparity` / `?diffconsumer` / `?encparity` / `?encoderout` / `?storeread` flags removed. These paths are the default with zero overhead when the old mirror is only used for bootstrap/getState.
- `crdt-response` payload is produced by the encoder (reserved LWW, tween path, source-captured grow-only PointerEventsResult + VideoEvent).
- Diff consumer is the default in `syncRenderer` (full walk remains only for hydration and periodic safety resync).
- Pointer bind now uses the projection view + facade for reads/iteration (writes already source-captured).
- Build + typecheck clean.

**Mirror Engine status:** Still present for:
- `crdt-get-state` bootstrap snapshot.
- A few legacy consumers (environment, PlayerSystem, ReservedEntitiesSync writes).

**Next (e9–e10):** projection-only reads + drop mirror `Engine()`; perf pass. See [PROGRESS.md](./PROGRESS.md) re-arch milestones.

This is the point where the second full `@dcl/ecs` engine on the main thread is no longer required for turning scene CRDT into a Three.js scene graph.

---

## 2026-06-16 — Re-arch e6 (boot-snapshot parity oracle) + PhysX grounding/collision overhaul

### Re-arch e6 — getState snapshot parity ✅

Non-breaking oracle that proves the new projection/encoder pipeline can reproduce the legacy mirror's boot snapshot before we cut over `crdt-get-state`.

- `CrdtProjection.serializeSnapshot()` + `sceneEntityCount()` — typed projection state → CRDT puts.
- `CrdtEncoder.serializeReservedSnapshot()` + `compareCrdtSnapshots()` / `decodeSnapshotPuts()` + `SnapshotParityReport` — reserved-entity LWW snapshot + parity diff.
- `SceneScriptSystem` `crdt-get-state` handler runs `auditBootSnapshot` → logs **`getState snapshot parity OK`** (engine N keys == new N keys). `NetworkEntity` / `NetworkParent` excluded to avoid false negatives.
- `CrdtMirror.getState()` remains the authoritative bootstrap source until the e9 cutover.

**Next:** e7 pointer same-tick gate (deliver `PointerEventsResult` via plain `crdt-response`) → e8 delete `crdt-renderer-push*` / stash-nudge → e9 encoder-only out + projection-only reads, drop the second `Engine()` → e10 perf pass.

### PhysX player grounding + collision readiness ✅ (user-confirmed)

Several compounding bugs made the local player float and/or fall through; all fixed:

| Fix | File | Notes |
| --- | ---- | ----- |
| Infinite ground = static **box** (top at y=0), not `PxPlane` | `PhysXWorld.ensureInfiniteGroundPlane` | `PxPlane` is unsupported by the CCT and by sweep/overlap scene queries → player never grounded and was invisible to the ground probe. A real thin box behaves like any static collider. |
| Player capsule is **simulation-only** | `PhysXWorld.spawnPlayer` | Removed `eSCENE_QUERY_SHAPE`; the ground/camera probes were self-hitting the player's own capsule (ray exits at capsule base = foot → every probe reported surface==foot). |
| Grounding uses **contact-point Y** | `PhysXWorld.feetYFromGroundHit` | Old distance formula returned the sphere-sweep *centre*, floating the player exactly one `groundSweepRadius` (0.29 m) above every surface — the universal float. |
| Ground-stick clamp retained | `PhysXWorld.movePlayer` | Settles CCT step-up overshoot onto raised floors; now operates on accurate surface data. |
| **Collision-readiness gate** | `World.prewarmPhysicsColliders` + `AppController.loadRoute` | Cooks all scene colliders (e.g. ~971 trimeshes) during the loading screen, **before** `world.start()`. Previously colliders cooked incrementally in the loop after the screen hid → player spawned into an uncollidable scene (fall-through) + main-thread cook jank ("slow then smooth"). Loops `syncCollision()` + `applyPhysicsColliders()` until the static-actor count stabilises, then snaps to ground. |

**Result:** player grounds flush on flat + raised colliders, collides with walls/props from the first frame, and the early-load jank is gone.

---

## 2026-06-16 — RickRoll drone GLTF render + physics lift fix; e7 partial validation

### Re-arch e7 — pointer validation (partial) 🟡

RickRoll `/rickroll.dcl.eth` drone (asset-pack Trigger + `PointerEvents`):

| Check | Status |
| ----- | ------ |
| Drone visible (mis-export GLB) | ✅ textured `drone_collider` art renders |
| Click / tween trigger | ✅ pointer raycast + scene tween fires |
| Push path (`crdt-renderer-push` / stash-nudge) | ✅ confirmed working pre-cutover |
| Same-tick `crdt-response` gate (e7 acceptance) | ⬜ still in progress — full Trigger QA on asset-pack scenes pending |

### RickRoll drone — GLTF mis-export render fix ✅

RickRoll `drone.glb` ships art on `drone_collider` (invisible class) and an untextured `Cube` pointer proxy (visible class).

- `src/collision/gltfRenderMeshes.ts` — `syncGltfInstanceRenderState()` detects mis-export (textured `_collider`, bare visible proxy) and shows the art mesh while keeping the proxy raycastable but camera-invisible.
- `ThreeBridge` calls render sync on attach and each sync frame.

### RickRoll drone — physics lift fix ✅

**Root cause:** GLTF physics extraction treated any mesh under a `_collider` ancestor as an invisible physics surface. RickRoll’s large untextured `Cube` pointer proxy ( `visibleMeshesCollisionMask: CL_POINTER` only) was incorrectly cooked into PhysX. When the drone tweened upward, that oversized proxy swept through the CCT and lifted the player even at a distance. Compounding issues: collision masks were not honored for invisible meshes, geometry fingerprints used per-extract clone UUIDs (forcing recook thrash), and GLTF trimesh transforms were baked into vertices with no pose update path for moving entities.

**Fix:**

| Area | Change |
| ---- | ------ |
| `gltfColliderNaming.ts` | `isGltfVisibleClassMesh()` — named non-`_collider` meshes stay visible-class even when nested under a `_collider` group |
| `GltfColliderExtractor.ts` | Honor `CL_PHYSICS` on both visible/invisible masks; stable source-geometry fingerprint; physics only on `_collider` meshes + visible meshes with `CL_PHYSICS` |
| `gltfPointerMeshes.ts` | Pointer targets use visible-class naming (Cube stays clickable, no physics) |
| `PhysXWorld.ts` | GLTF trimesh colliders cook in mesh-local space; `setGlobalPose` updates pose when entity moves (no recook per frame) |

**Result:** pointer proxies no longer block movement; `_collider` meshes provide physics only; mis-export render workaround does not break layer separation.

### Community docs + repo migration readiness

- `docs/TASKS.yaml` — e7 notes updated with RickRoll partial validation.
- `docs/PROGRESS.md` — this entry; branch `redo/threejs-projection-arch` ready to snapshot before blank-repo migration.
- `npx tsc --noEmit` — ✅ clean.

---

## 2026-06-16 — Re-arch e7/e8 — pointer via crdt-response; push channel deleted

### Re-arch e7 — pointer same-tick via crdt-response ✅ (code complete; browser QA pending)

Pointer results now ride the normal **`crdt-response`** path by default (no `?pushlesspointer` flag):

1. `PointerEventsSystem` writes + `recordAppend` source-captures each `PointerEventsResult`.
2. `flushPendingPointerCrdt()` encodes synchronously → `pointerResponseStash` → `crdt-round-trip-nudge`.
3. Empty-body nudge `crdt-send` merges stash bytes into `crdt-response`; worker stub applies inbound same frame.

| Check | Status |
| ----- | ------ |
| RickRoll drone click/tween (legacy push path) | ✅ user-confirmed pre-cutover |
| Default crdt-response + nudge path (e7/e8) | ⬜ **re-validate in browser** — RickRoll F-key, Genesis watering plants, asset-pack Triggers |
| Debug | `?pointerverbose` — flush + crdt-response byte counts |

### Re-arch e8 — delete crdt-renderer-push / stash / ack ✅

Removed the dedicated push channel and compensation machinery:

| Deleted | Notes |
| ------- | ----- |
| `crdt-renderer-push` / `crdt-renderer-push-ack` | worker protocol + main handler |
| `rendererPushQueue`, `deliverRendererInbound`, `takeRendererPushQueue` | worker |
| `rendererPushStash`, ack timers, `schedulePointerStashNudge` | `SceneScriptSystem` |

**Retained:** `crdt-round-trip-nudge` — still required for same-tick pointer delivery.

### e7/e8 pointer delivery fix — Genesis clicks (2026-06-16)

**Root cause:** After e8, two gaps broke click → scene script delivery:

1. **Stash race** — any in-flight scene-tick `crdt-send` could `takePointerResponseStash()` before the nudge round-trip, leaving the nudge with 0-byte `crdt-response` while PET_DOWN/UP were already logged on main.
2. **Missing `engine.update(0)` after nudge** — stub apply queues inbound CRDT on the renderer transport, but `@dcl/ecs` only processes it in `receiveMessages()` at the start of `engine.update()`. Nudge only called `sceneOnUpdate(0)`, so `inputSystem.getClick()` never saw `timestampIsCurrentFrame(up)`.

**Fix:**

| File | Change |
| ---- | ------ |
| `SceneScriptSystem.ts` | Consume `pointerResponseStash` only on empty-body (nudge) `crdt-send`; mirror `flushOutgoing()` fallback when encoder encode is empty; warn to console when stash is 0 bytes |
| `sceneWorker.ts` | After nudge stub apply, run `sceneEngine.update(0)` then `sceneOnUpdate(0)` |

| Check | Status |
| ----- | ------ |
| Default crdt-response + nudge path (e7/e8) | ⬜ **re-validate in browser** — Genesis watering plants, RickRoll F-key, asset-pack Triggers |
| Debug | `?pointerverbose` — flush + crdt-response byte counts; 0-byte stash warns without flag |

**Next:** e9 projection-only reads + drop mirror `Engine()`; e10 perf pass.

---

## 🎉 Milestone — Genesis Plaza perf + locomotion parity (2026-06-17)

**User-confirmed:** Genesis Plaza (~2423 entities, ~926 GLTFs) **70–110 fps** after pointer fix (was ~12–23 fps with brutal memory pressure). Colliders blocking on buildings/planters. DCL auto-jog speed + animation aligned with Explorer.

### PointerEvents perf — root cause ✅

| Issue | Fix | File |
| ----- | --- | ---- |
| Every frame: rebuild 512-entity pointer set + scan **all 2423 Transform entities** per pointer (recursive) ≈ **1.2M checks/frame** | Cached pointer targets (`childrenByParent` BFS); invalidate on layout change only | `PointerEventsSystem.ts` |
| Hover raycast every frame | Throttle to every 3 frames unless mouse moved / clicking | `PointerEventsSystem.ts` |
| `syncInput` full rebuild | Uses cache rebuild path | `PointerEventsSystem.ts` |
| Player idle still stepping physics | Skip `movePlayer` + `physics.step` when grounded idle | `PlayerSystem.ts`, `PhysXWorld.ts` |
| Projection fold dirty on every pose tick | Exclude player/camera/root from structural dirty; throttle async bridges | `SceneScriptSystem.ts` |

### GLTF colliders + prewarm ✅

| Fix | Notes |
| --- | ----- |
| Hyperfy-style grouped actors + pose-only sync | `GltfColliderExtractor.ts` — shared geometry refs, no clone-at-extract |
| Prewarm gate exits early at partial count | `World.prewarmPhysicsColliders()` — stability wait until GLTF registration plateaus |
| Collisions ready before `world.start()` | No fall-through / slow-then-smooth cook period on entry |

### Social / locomotion polish ✅

| Area | Fix |
| ---- | --- |
| Remote bundled emotes | `DLEraiseHand …` chat text → `playPeerEmote` via `tryParseChatEmoteCommand` (`dclRfc4Chat.ts`, `Rfc4Router.ts`) |
| DCL auto-jog | Default **8 m/s** + **run.glb slowed** (~0.88×) — not walk sped up (`AvatarAnimations.ts`) |
| Shift sprint | **12 m/s** + full run animation (`locomotion.ts`) |

### Re-arch status snapshot (2026-06-17)

| Step | Status | Notes |
| ---- | ------ | ----- |
| Phase 0–2 (projection + diff consumer) | ✅ | Default on branch |
| Phase 3 (encoder default) | ✅ | 2026-06-15 |
| e6 boot-snapshot parity oracle | ✅ | |
| e7 pointer same-tick via crdt-response | ✅ code | Browser QA: Genesis clicks, RickRoll F-key — re-validate as needed |
| e8 delete crdt-renderer-push / stash | ✅ | |
| **e9 drop `CrdtMirror` Engine()** | ✅ | `CrdtMirror.ts` deleted; `RendererComponentHost` schema-only; projection bootstrap `getState` |
| **e10 perf pass** | ⬜ **deferred** | Pointer cache win landed (70–110 fps); shadows/instancing/resync tuning later |
| **Phase 4 unified EntityStore** | ✅ **closed** | Store owns scene nodes + remote avatars; diff + full-resync via `applySceneDiff` |

**Uncommitted working tree:** large batch on `redo/threejs-projection-arch` — commit + push when ready.

---

## 2026-06-17 — Phase 4 kickoff: EntityStore

First slice of the unified Three.js-backed entity store (EntityStore phase — see INTEGRATION.md):

| File | Change |
| ---- | ------ |
| `src/bridge/EntityStore.ts` | **New** — entity → `THREE.Group` map, `owner` tag, create/destroy, change subscriptions |
| `src/bridge/ThreeBridge.ts` | Scene graph nodes live in `EntityStore` (not private `nodes` map) |
| `src/core/systems/SceneScriptSystem.ts` | Owns `EntityStore` lifecycle; passes to `ThreeBridge` |

### Phase 4 slice 1 — Transform apply (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/entityStoreApply.ts` | **New** — `applySceneDiff`: Transform + Visibility + LightSource mutate groups in place |
| `src/bridge/ThreeBridge.ts` | `consumeDiff` delegates scene-graph patch to EntityStore apply path |
| `SceneScriptSystem.ts` | Store create/destroy → pointer cache invalidate |

### Phase 4 slice 2 — Mesh notify + collision/pointer subscriptions (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/entityStoreApply.ts` | Mesh/collider/pointer CRDT diffs emit `notifyComponentChange`; tween refresh skips Transform notify |
| `src/bridge/ThreeBridge.ts` | `notifyMeshComponent` after GLB/primitive/text/material attach lands |
| `src/core/systems/SceneScriptSystem.ts` | `onEntityStoreChange` drives `collisionDirty` / `pointerStructureDirty`; removed duplicate flags from `foldProjectionChanges` |

### Phase 4 slice 3 — Full-walk dedup + bridgeDirty consolidation (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/entityStoreApply.ts` | `notifySecondary` option; Animator/AvatarShape bridge notifications |
| `src/bridge/ThreeBridge.ts` | `sync()` full walk delegates transform/visibility/light to `applySceneDiff` (no duplicate loop) |
| `src/core/systems/SceneScriptSystem.ts` | `bridgeDirty` from EntityStore (GltfContainer/Animator/AvatarShape); `foldProjectionChanges` diff-only |

### Phase 4 slice 4 — Store-backed hydration + owner guards (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/EntityStore.ts` | `forEachSceneEntity`, `isSceneOwned` — scene-only iteration |
| `src/bridge/ThreeBridge.ts` | `getHydrationStats` walks store (not Transform projection map); full-resync teardown skips avatar-owned nodes; video material invalidation store-scoped |
| `src/bridge/entityStoreApply.ts` | Removals limited to `owner:'scene'` records |

### Phase 4 slice 5 — Remote avatars in store (2026-06-17)

| File | Change |
| ---- | ------ |
| `src/bridge/EntityStore.ts` | `upsertAvatar` / `removeAvatar`, `avatarEntityFromAddress` synthetic ids |
| `src/network/RemoteAvatarManager.ts` | Peer roots registered in EntityStore (`owner:'avatar'`) |
| `src/core/World.ts` | Wires `RemoteAvatarManager.setEntityStore` after scene prepare |
| `src/core/systems/SceneScriptSystem.ts` | Avatar store changes skip collision/pointer dirty flags |

**Phase 4 closed.** Deferred to e10: `FULL_RESYNC_INTERVAL` tuning. Local player capsule remains outside store until a later pass (later pass).

