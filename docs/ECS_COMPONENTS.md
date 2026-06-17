# DCL SDK7 — ECS Component Reference

> **Community checklist:** [INTEGRATION_STATUS.md](./INTEGRATION_STATUS.md) — all ECS + UI + networking + performance in one place.  
> **Test your work:** [CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md) — deploy a minimal scene to your own world (live immediately).  
> **Source of truth (ECS IDs):** `@dcl/sdk` + `src/dcl/ecs/registry.ts`  
> **Client status key:** ⬜ not started · 🟡 stub/partial · 🟢 render/sync · 🔵 client-only  
> **Last synced:** 2026-06-17 — matches `registry.ts` + `integrationRegistry.ts`

---

## Glossary

| Term | Meaning | Client |
| ---- | ------- | ------ |
| **Tags** | ECS labels (`Tags.tags[]`); `engine.getEntitiesByTag("x")` | ✅ mirror CRDT sync |
| **`PET_PROXIMITY_*`** | PointerEvents types when **player walks near** entity (not cursor ray) | ⬜ only cursor pointer events implemented |
| **TriggerArea** | Separate volume component — enter/exit/stay in a box/sphere | ⬜ not started (different from PET_PROXIMITY) |

---

## Implementation snapshot (2026-06-14)

**Done (🟢):** Transform, MeshRenderer, Material, VisibilityComponent, MeshCollider, AvatarLocomotionSettings (read), SkyboxTime, AvatarShape (NPC compose), **LightSource**, **TextShape**, **Billboard**, **Animator**, **PointerEvents**, **EngineApi sendBatch/subscribe** (comms queue)

**Partial (🟡):** PointerLock (browser API in `PlayerInput`, not ECS-driven), **GltfContainerLoadingState** (optional loading UI — loader itself is ✅), **PointerEvents** (cursor only — no `PET_PROXIMITY_*`)

**Client-owned (🔵):** MainCamera, PlayerEntity/CameraEntity sync, reserved entity transforms, **PointerEventsResult**, **PrimaryPointerInfo**

**Next sprint (Phase 3):** **Raycast** → TriggerArea → **VideoPlayer / videoEvent** → UiTransform · **PET_PROXIMITY**

**Counts:** ~18 of 60+ components have render/sync or stub coverage.

---

## Summary by phase


| Phase  | Focus                                     | Done | Next up                                |
| ------ | ----------------------------------------- | ---- | -------------------------------------- |
| **1**  | Scene script boot, CRDT mirror, static 3D | 6/6  | —                                      |
| **1b** | Scene fidelity                            | 4/6  | GltfContainerLoadingState optional     |
| **2**  | Player, collision, camera                 | 5/5  | Phase 2b closed                        |
| **3**  | Input, UI, media, motion                  | 3/22 | **Raycast** → TriggerArea → UI   |
| **4**  | Avatars & identity                        | 1/6  | AvatarEmoteCommand (4d)                |
| **5**  | Multiplayer sync tags                     | 0/3  | —                                      |
| **6**  | Advanced / polish                         | 0/12 | —                                      |


---

## Core transform & identity


| Component               | ID     | Phase | Client status | Notes                                            |
| ----------------------- | ------ | ----- | ------------- | ------------------------------------------------ |
| **Transform**           | 1      | **1** | 🟢             | `ThreeBridge` + `dclTransform.ts` hierarchy      |
| **Name**                | manual | 1     | ⬜             | Debug/editor; optional in shim                   |
| **Tags**                | manual | 1     | 🟢             | String labels; `engine.getEntitiesByTag()` — mirror CRDT sync |
| **VisibilityComponent** | 1081   | **1** | 🟢             | `obj.visible` in ThreeBridge                     |


---

## 3D rendering (Phase 1 P0)


| Component                     | ID   | Phase | Client status | Notes                                       |
| ----------------------------- | ---- | ----- | ------------- | ------------------------------------------- |
| **GltfContainer**             | 1041 | **1** | 🟢             | `ThreeBridge` + `AssetCache` — reload on src change |
| **GltfContainerLoadingState** | 1049 | 1b    | ⬜             | Loading/error UI optional                   |
| **GltfNodeModifiers**         | 1099 | 6     | ⬜             | Per-node material overrides                 |
| **MeshRenderer**              | 1018 | **1** | 🟢             | Primitives — custom box/plane UVs, Material offset/tiling, textureMove tweens |
| **Material**                  | 1017 | **1** | 🟢             | PBR/unlit + textures via `MaterialApplier`  |
| **Animator**                  | 1042 | 1b    | 🟢             | `AnimatorBridge` — glTF clips via `AssetCache` |
| **Billboard**                 | 1090 | 1b    | 🟢             | `BillboardBridge` — Y-axis / lookAt         |
| **LightSource**               | 1079 | 1b    | 🟢             | `LightSourceSync` — point/spot lights       |
| **TextShape**                 | 1030 | 1b    | 🟢             | `TextShapeSync` — canvas texture planes     |
| **NftShape**                  | 1040 | 6     | ⬜             | NFT frame preview                           |
| **ParticleSystem**            | 1217 | 6     | ⬜             | GPU particles                               |


---

## Environment & sky (defer)


| Component      | ID   | Phase | Client status | Notes                                     |
| -------------- | ---- | ----- | ------------- | ----------------------------------------- |
| **SkyboxTime** | 1210 | 3     | 🟢             | `EnvironmentSystem` — fixedTime + day cycle |
| **EngineInfo** | 1048 | 6     | 🔵            | Client/engine metadata                    |
| **RealmInfo**  | 1106 | 6     | 🔵            | Realm name stub in Phase 1 `Runtime`      |


---

## Physics & locomotion (Phase 2)


| Component                    | ID   | Phase | Client status | Notes                                                          |
| ---------------------------- | ---- | ----- | ------------- | -------------------------------------------------------------- |
| **MeshCollider**             | 1019 | **2** | 🟢             | PhysX static + `CollisionSystem` raycast meshes                |
| **PhysicsCombinedForce**     | 1216 | 6     | ⬜             | Rapier forces                                                  |
| **PhysicsCombinedImpulse**   | 1215 | 6     | ⬜             | Rapire impulses                                                |
| **AvatarLocomotionSettings** | 1211 | **2** | 🟢             | Read in `locomotion.ts` — walk/jog/run/jump tuning             |
| **PointerLock**              | 1074 | **2** | 🟡             | Browser pointer lock in `PlayerInput` (not ECS component yet)  |
| **InputModifier**            | 1078 | 3     | 🟢             | Read in `locomotion.ts` — disable walk/jog/run/jump flags             |


---

## Camera (Phase 2–3)


| Component          | ID   | Phase | Client status | Notes                                    |
| ------------------ | ---- | ----- | ------------- | ---------------------------------------- |
| **MainCamera**     | 1075 | **2** | 🔵            | Registered + synced via `ReservedEntitiesSync` |
| **VirtualCamera**  | 1076 | 3     | ⬜             | Cinematic blend                          |
| **CameraMode**     | 1072 | 4     | ⬜             | First/third person     |
| **CameraModeArea** | 1071 | 4     | ⬜             | Zone-based camera mode |


---

## Input, pointers, raycasts (Phase 3)


| Component               | ID   | Phase | Client status | Notes                                      |
| ----------------------- | ---- | ----- | ------------- | ------------------------------------------ |
| **PointerEvents**       | 1062 | **3** | 🟢             | Raycast + hover icons + highlight + all desktop input actions |
| **PointerEventsResult** | 1063 | **3** | 🔵            | Grow-only CRDT back to scene worker |
| **PrimaryPointerInfo**  | 1209 | **3** | 🔵            | Cursor ray on `RootEntity` via `PointerEventsSystem` |
| **Raycast**             | 1067 | **3** | ⬜             | Scene → engine ray         |
| **RaycastResult**       | 1068 | **3** | 🔵            | Hit data back to scene     |
| **TriggerArea**         | 1060 | **3** | ⬜             | Volume enter/exit          |
| **TriggerAreaResult**   | 1061 | **3** | 🔵            | Trigger events to scene    |


---

## UI (React ECS / canvas — Phase 3)


| Component               | ID   | Phase | Client status | Notes              |
| ----------------------- | ---- | ----- | ------------- | ------------------ |
| **UiTransform**         | 1050 | **3** | ⬜             | DOM overlay or RTT |
| **UiText**              | 1052 | **3** | ⬜             |                    |
| **UiBackground**        | 1053 | **3** | ⬜             |                    |
| **UiCanvasInformation** | 1054 | **3** | 🔵            | Canvas size        |
| **UiInput**             | 1093 | **3** | ⬜             |                    |
| **UiInputResult**       | 1095 | **3** | 🔵            |                    |
| **UiDropdown**          | 1094 | **3** | ⬜             |                    |
| **UiDropdownResult**    | 1096 | **3** | 🔵            |                    |


---

## Audio & video (Phase 3)


| Component         | ID   | Phase | Client status | Notes           |
| ----------------- | ---- | ----- | ------------- | --------------- |
| **AudioSource**   | 1020 | **3** | ⬜             | Spatial clip    |
| **AudioStream**   | 1021 | **3** | ⬜             | URL stream      |
| **AudioEvent**    | 1105 | **3** | 🔵            | Playback events |
| **AudioAnalysis** | 1212 | **3** | 🔵            | FFT / volume    |
| **VideoPlayer**   | 1043 | **3** | 🟢             | `VideoPlayerBridge` — texture on mesh + VideoEvent outbound |
| **VideoEvent**    | 1044 | **3** | 🔵            | Playback events |


---

## Motion / tween (Phase 3)


| Component         | ID   | Phase | Client status | Notes         |
| ----------------- | ---- | ----- | ------------- | ------------- |
| **Tween**         | 1102 | **3** | 🟢             | `TweenBridge` — transform + textureMove/continuous; 31 easings; restart on mode change |
| **TweenSequence** | 1104 | **3** | 🟢             | Genesis blimp orbit validated via `TweenBridge` |
| **TweenState**    | 1103 | **3** | 🔵            | Written by `TweenBridge`; read by worker `tweenCompleted()` |


---

## Avatars (Phase 4)


| Component              | ID   | Phase | Client status | Notes                 |
| ---------------------- | ---- | ----- | ------------- | --------------------- |
| **AvatarShape**        | 1080 | **4** | 🟢             | `AvatarShapeBridge` — NPC compose + name tags |
| **AvatarBase**         | 1087 | **4** | ⬜             | Base mesh             |
| **AvatarAttach**       | 1073 | **4** | ⬜             | Parent to bone        |
| **AvatarEmoteCommand** | 1088 | **4** | 🟢             | `AvatarEmoteCommandBridge` — player + NPC emotes |
| **AvatarEquippedData** | 1091 | **4** | 🔵            | Client → scene        |
| **AvatarModifierArea** | 1070 | **4** | ⬜             | Force wearables       |
| **PlayerIdentityData** | 1089 | **4** | 🔵            | Wallet / display name |


---

## Networking (Phase 5)


| Component          | ID       | Phase | Client status | Notes               |
| ------------------ | -------- | ----- | ------------- | ------------------- |
| **NetworkEntity**  | manual α | **5** | 🟡             | Projection decode + Transform parent strip |
| **NetworkParent**  | manual α | **5** | 🟡             | Projection decode + Transform parent strip |
| **SyncComponents** | manual α | **5** | ⬜             | Component whitelist |


---

## Assets & misc (Phase 6)


| Component                 | ID   | Phase | Client status | Notes               |
| ------------------------- | ---- | ----- | ------------- | ------------------- |
| **AssetLoad**             | 1213 | 6     | ⬜             | External asset load |
| **AssetLoadLoadingState** | 1214 | 6     | 🔵            |                     |
| **MapPin**                | 1097 | 6     | ⬜             | Minimap pin         |


---

## Engine API / ~system modules (not ECS components)

Scene bundles `require()` these; shim by phase:


| Module                             | Phase | Client status | Purpose                                       |
| ---------------------------------- | ----- | ------------- | --------------------------------------------- |
| `~system/EngineApi`                | **1** | 🟢             | CRDT ✅ · **`sendBatch` / `subscribe` ✅** (SDK7 **`comms`** only) |
| `~system/Runtime`                  | **1** | 🟢             | `getSceneInformation`, `getRealm`             |
| `~system/RestrictedActions`        | 2     | 🟡             | `movePlayerTo` ✅ · `triggerEmote` ✅ · `openExternalUrl` ✅ — `openNftDialog` ⬜ |
| `~system/CommunicationsController` | 5     | 🟢             | `sendBinary` ✅ · **`send` ✅** (topic `comms`) |
| `~system/UserIdentity`             | 5     | 🟢             | `getUserData` RPC + mirror ECS for `getPlayer()` |
| `~system/CommsApi`                 | 5     | 🟡             | topics ✅ · **`getActiveVideoStreams` ⬜ pending** (VideoPlayer) |
| `~system/SignedFetch`              | 3     | 🟢             | `signedFetch` + `getHeaders` via worker RPC → main thread |
| `~system/EnvironmentApi`           | 1     | ⬜             | Bootstrap metadata (optional)                 |
| `~system/Testing`                  | —     | ⬜             | Preview tests only                            |

Full no-op inventory: [`PROGRESS.md` § ~system stubs — intentional no-ops](./PROGRESS.md#system-stubs--intentional-no-ops-revisit).


---

## Phase 1 bridge priority (remaining)

1. ~~CRDT mirror engine~~ ✅
2. ~~Transform → Three.js hierarchy~~ ✅
3. ~~MeshRenderer + Material~~ ✅
4. ~~VisibilityComponent~~ ✅
5. Validate **GltfContainer** on glTF-heavy world
6. **Phase 3:** ~~PointerEvents + PointerEventsResult~~ → **Raycast** + TriggerArea
7. **Phase 1b:** **LightSource**, **TextShape**, **Billboard**, **Animator**
8. **Phase 2b:** ✅ `RestrictedActions.movePlayerTo`, parcel clamp, spawn camera
9. **Phase 5 prep:** `SessionIdentity`, `RemoteAvatarManager`, profile localStorage cache

Unknown components: **log once** and skip render until phased — scene script should still run.

---

## Related

- `[INTEGRATION_STATUS.md](./INTEGRATION_STATUS.md)` — **community master checklist** (ECS + UI + networking + performance)
- `[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)` — phased rollout
- `[PROGRESS.md](./PROGRESS.md)` — current status
- `[src/dcl/ecs/registry.ts](../src/dcl/ecs/registry.ts)` — machine-readable ECS registry
- `[src/client/dev/integrationRegistry.ts](../src/client/dev/integrationRegistry.ts)` — full integration registry

