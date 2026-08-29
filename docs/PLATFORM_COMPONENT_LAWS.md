# Platform component laws (Explorer parity)

> **Authority:** `@dcl/ecs` protobuf comments + [DCL creator docs](https://docs.decentraland.org/creator/scenes-sdk7/) + this client’s Tier B / bridge history.  
> **Not authority:** fishing-session trial rotations, scene-name forks, “looks better” UV flips.  
> **Scene bundle** decides *which* APIs to call; **this file** is the client’s *how* for those APIs.  
> See also: [AGENTS.md](./AGENTS.md) (refactor the law), skill `scene-bundle-is-law`.

**Status:** living. Mark each row **Verified** / **Client convention** / **Open gap**.

---

## How to use this doc

1. Before changing a bridge, find the component here.  
2. If the row is **Open gap**, do not invent — fetch Explorer or measure Explorer.  
3. If the row is **Verified**, implement only that law.  
4. Scene-specific math (e.g. GP fishing `I5e`) is **scene code**, not a reason to fork AvatarAttach.

---

## 1. Billboard (1090)

### Verified (docs + `@dcl/ecs` + DCL entity-positioning)

| Rule | Source |
|------|--------|
| Billboard makes the entity **reorient to face the player camera** | [Entity positioning — Face the player](https://docs.decentraland.org/creator/scenes-sdk7/3d-content-essentials/entity-positioning.md) |
| **Only rotation** is affected; scale/position stay on Transform | `@dcl/ecs` `PBBillboard` comment |
| Default mode when omitted: **BM_ALL (7)** | `@dcl/ecs` `billboardMode?: … (default: BM_ALL)` |
| Valid modes: `BM_NONE=0`, `BM_X=1`, `BM_Y=2`, `BM_Z=4`, `BM_ALL=7`, and **BM_X\|BM_Y** | `@dcl/ecs` `BillboardMode` enum |
| **BM_ALL**: face player on all axes (including pitch if player is above) | DCL docs |
| **BM_Y**: yaw only; stay perpendicular to ground | DCL docs |
| Transform.rotation is **not** rewritten as the billboard follows (local presentation) | DCL docs |
| Facing is **local per player** (each client aims at their camera) | DCL docs |
| Optional `targetEntity` (newer docs) — face that entity instead of camera | DCL docs |

### Client implementation law (this repo)

| Rule | Status |
|------|--------|
| **BM_Y / X\|Y:** `yaw = atan2(cam.x − worldPos.x, cam.z − worldPos.z)` in **display** space | Verified — original bridge + aefccaf |
| **BM_ALL:** Three.js **lookAt** worldPos → camera (object **−Z** toward camera) | Verified — original bridge; Three convention |
| Sample **world** position of the entity (parent chain), not local `obj.position` | Client convention (required for parented roots) |
| Write rotation as **parent-local** quaternion | Client convention (hierarchy) |
| Do **not** invent `Ry(π)`, `scale.x = −1`, or dual-face UV roll in Billboard | **Forbidden** (reverted) |

### Open gap

| Gap | What would close it |
|-----|---------------------|
| Exact Unity Explorer matrix for BM_ALL vs Three lookAt (−Z) | Read explorer-desktop / Unity renderer billboard code |
| Whether dual-face MeshRenderer UVs + lookAt match Explorer pixel-for-pixel | Golden capture Explorer vs client on same plane+texture |

### GP fishing (scene only)

```text
Billboard.create(p9)           // default BM_ALL
MeshRenderer.setPlane(N1)
Transform N1 parent=p9
BasicMaterial press_e_ui.png
Visibility on N1 toggles show/hide
```

Client must run **platform Billboard + plane + Visibility**. No GP-specific Billboard path.

---

## 2. MeshRenderer plane + UVs

### Verified (docs)

| Rule | Source |
|------|--------|
| Plane is a primitive MeshRenderer shape | shape-components / materials docs |
| Plane has **two faces**; UV array lists **8 points for front + 8 for back** (16 floats when fully authored) | materials — Set UVs |
| Docs north packing: **BL, BR, TR, TL** then south **BR, BL, TL, TR** | materials `setUVs` example |
| Empty `uvs` → full-tile default | MeshRenderer helpers |
| Dual-face + materials for billboard images often use **BasicMaterial** (unlit) | materials — unlit / billboard images |

### Client implementation law (this repo)

| Rule | Status |
|------|--------|
| Dual-face BufferGeometry, north + south | Verified — `primitiveShapes.ts` |
| Docs UV *values* + **X-reflection corner maps** north **[3,2,0,1]**, south **[2,3,1,0]** | Verified — `dclToThreePos` reflects +X; pure docs maps L–R-mirror Jump Zone / TextShape / JUMP IN |
| Default north is docs **V=0 bottom** (`0,0,1,0,1,1,0,1`). South is same-cell docs south | Verified — NftShape / TextShape / default planes |
| Dual-face south is **same-cell docs south from normalized north** (`northStyleToSouthPacking`). Authored second octuple is not trusted (plaza missed-it copies north-order; R4e GET BAIT is south flipbook of the same cell). Never `1−u` except marquee | Verified — v31 packing / v33 X-reflection corners |
| TextShape canvas uses the same plane. **Do not** also flip `map.repeat.x` by default | Forbidden — v31+flip re-mirrored Jump Zone (−130,91) |
| Marquee / flipbook special cases stay on their own packing | Client law for those UV patterns |
| **Do not** invert default north V to fix one Billboard | Forbidden — hung every NFT + canvas plane upside-down |
| **Do not** treat authored 16-UV south as a second north face | Forbidden — L–R mirrored GET BAIT while default-UV press_e stayed upright |

### Open gap

| Gap | Note |
|-----|------|
| Press_e under stock lookAt | **Closed (v28)** — default south keeps north V (V=0 bottom). Extra south-V invert + Matrix4.lookAt (−Z to camera) read the start-reeling plane upside-down. Do not invert north. |
| 16-UV atlas south L–R mirror | **Closed (v30)** — authored south is south packing. `northStyleToSouthPacking(normalizeNorth(south))` double-packed GET BAIT. |

---

## 3. VisibilityComponent (1081)

### Verified (docs)

| Rule | Source |
|------|--------|
| `visible: false` makes the entity invisible | shape-components — Make invisible |
| Works for primitives and GltfContainer | docs |
| Optional `propagateToChildren` | docs |
| Own Visibility on child **overrides** parent propagate | docs |

### Client implementation law

| Rule | Status |
|------|--------|
| `obj.visible = Visibility.visible !== false` when component present | Verified — `entityStoreApply` |
| Apply to pose group + DrawWorld / `__mesh_*` **clone root** — never every descendant mesh | Verified — per-mesh rewrite unhides `*_collider` (ice-rink door) and drops click_area from pointer collect |
| Visibility `true` on a GltfContainer must load+attach this frame (budget bypass) | Verified — MeshRenderer already had `ensureMeshRendererLeaf`; catch/loot GLBs only flip Visibility |
| GltfContainer **fetch** is never budget-gated (only attach is). Visibility + normal scale (not LO() 0.001) attaches even while `visible=false` | Verified — plaza n0 is created hidden at reel start; 5s reveal cannot wait for a late parse |
| Do **not** invent scale rewrites on show/hide | Forbidden (broke missed-it Scale tweens) |
| Do **not** force-show fishing rods ignoring Visibility | Forbidden (reverted) |
| Visibility puts must not starve behind slow peel (same class as Transform motion) | Client COD drain policy |
| Visibility hides drawing, not PointerEvents / colliders | Platform — Creator Hub `click_area` is `visible: false` + `CL_POINTER`; scale collapse (plaza LO() 0.001) is the PE-drop signal |
| Do **not** cull PE meshes by player↔Transform origin (or any keep-radius) | Forbidden — Explorer raycasts the PE set; `maxDistance` is the only range gate |
| World-mesh PET: host inject writes 1063, then **one** serialized `eng.update` this edge | Verified — Bevy/Explorer: write then tick. Asset-pack `on_click` is `getInputCommand` **this frame**. Do not queue-until-play-frame; do not stack two updates on one edge |
| World-mesh Animator (1042) CRDT from that tick must apply on main **this edge** | Verified — scene-UI holds non-UI until `uiEntities`; world-mesh never sends that. Dropping the buffer on deliver-done left Door Open on the worker mixer only |
| InstancedMesh lives off the pose graph — hide = zero-scale instance slot (`writeMatrix`) | Verified — `SceneGltfInstancer` |
| First GPU-instance write must see pose Visibility (LO() hides plaza pond benches, then GLB attaches) | Platform — apply authored vis **before** `instancer.attach` |
| `writeWorldMatrix` (billboard extract) must not unhide a `visible=false` pose | Platform |
| InstancedMesh is for **repeated low-leaf** props (≤12 render leaves). High-leaf kits clone | Platform — `templateIsInstancable` |
| First clone of a hash that cannot instance is not idle-queued | Platform — runtime-created unique GLBs |

---

## 3c. Scene `fetch` (worker)

### Verified (Explorer)

| Rule | Source |
|------|--------|
| Scene `fetch(url)` is the **browser** request (page origin, user IP) | Explorer worker |
| Hosts that reflect `Origin` / send ACAO work without a server hop | browser CORS |
| `/api/scene-http` is only a **CORS fallback** (no ACAO on the real host) | this client |

### Client implementation law

| Rule | Status |
|------|--------|
| Try the real URL first; on `TypeError` (CORS / failed to fetch) or HTTP 404 retry `/api/scene-http` | Platform |
| Remember the host only when the proxy recovers (later polls skip the direct miss) | Platform |
| Do **not** proxy-first — server IP 403s origins the browser is allowed to read | Forbidden |
| Do **not** special-case scene filenames or sheet names | Forbidden |

---

## 3b. Gltf `_collider` vs water visual

### Verified

| Rule | Status |
|------|--------|
| Name contains `_collider` → invisible physics/pointer hull | DCL glTF convention |
| Never unhide collider meshes to “see” a texture | **Forbidden** (reverted) |
| Creator Hub **Invis** (MASK + baseColor alpha 0, no map) stays discarded — do not force `opacity=1` | Verified — Winterfest `Entry_Door_1` click hull |

### Client law

Plaza `water_surface.glb` is a collider-only disk + sibling `water.png`. Pointer/physics stay on the hidden hull. The renderer adds a **visible-class** display mesh (`dclWaterVisual`, same geo, not named `_collider`) and applies Explorer `Pond.mat` (Stylized Water: dual caustics scroll, refraction/spec, WaterColor/ShallowColor) using `water.png`.

---

## 3b2. GltfContainer collision masks (ADR-215)

### Verified (SDK docs + ADR-215 + `@dcl/ecs` PBGltfContainer)

| Rule | Source |
|------|--------|
| `visibleMeshesCollisionMask` omitted → **0** (visible art is not physics/pointer) | ADR-215 / docs |
| `invisibleMeshesCollisionMask` omitted → **CL_PHYSICS \| CL_POINTER** (`*_collider` hulls) | ADR-215 / docs |
| Explicit **0** is CL_NONE — not “use the default”. Protobuf encodes 0; do not `|| default` | `@dcl/ecs` optional uint32 |
| Inv-class = mesh or ancestor name contains `_collider` (case insensitive) | ADR-215 |
| Inv mask with CL_PHYSICS and **zero** `_collider` meshes → **no actor** | docs: assign vis mask to make vis art collide |
| Material name (`Collider_MAT`) / exporter name (`Cube`) does **not** make a mesh inv-class | ADR-215 name rule only |

### Client law

A decorative waterfall GLB whose only node is `Cube` (no `_collider`) must not cook PhysX even when Creator Hub left `invisibleMeshesCollisionMask: 3` (default). Walk-blockers on that art are vis-mask physics or a different entity (MeshCollider / invisible-wall vis=2), never an invented Cube hull.

---

## 3d. GltfNodeModifiers (path + Texture.Common)

### Verified (SDK + Explorer)

| Rule | Source |
|------|--------|
| `path` is a Unity/glTF node path; `""` = every mesh under the visual | `@dcl/ecs` GltfNodeModifiers |
| Paths may **include the asset root** (`AnimatedBanner/Child/Mesh`) | Unity Transform.Find / scene bundles |
| `Texture.Common({ src })` may be a scene file **or an https URL** | plaza / event cards / store boards |

### Client implementation law

| Rule | Status |
|------|--------|
| Resolve first path segment against the visual root **and** descendants | Platform |
| Merge static leaves only for generic exporter names — never authored names | Platform — named nodes are modifier targets |
| Keep retrying apply until textures land — do not drop pending on first miss | Platform |
| Authored glTF UVs stay as-exported — **no geometry U flip** on Texture.Common cards | Platform — Explorer uses the GLB as-is |
| VideoTexture is shared (`flipY=false`). Per-mesh geometry V only when bound **and** authored V=0 is at mesh bottom | Platform — Creator Hub `video_player.glb` already has V=0 at top (Pink Oasis / Los Cat). MeshRenderer planes (neat) use flipY=true |

---

## 3e. VideoPlayer + VideoTexture

### Verified (Explorer desktop + scene bundles)

| Rule | Source |
|------|--------|
| `VideoPlayer.playing=true` decodes `src` (mp4 / HLS / LiveKit) onto materials that reference `Texture.Video({ videoPlayerEntity })` | `@dcl/ecs` VideoPlayer + Material |
| Creator Hub `video_player.glb` (Burj, Pink Oasis, Los Cat) ships an authored albedo | scene GLB |
| Explorer **keeps that albedo until a decoded video frame exists** | Explorer desktop — Burj `-148,97` has no black quad in the camera while HLS buffers |
| `playing=false` / natural end / empty src → black screen (theatre idle / Admin deactivate) | Explorer |
| Occupancy / FocusOwner media pause **pauses decode** and keeps the last frame (or the GLB if none) | this client — painting black on occupancy flashed Burj `place_on_camera` in the face |

### Client implementation law

| Rule | Status |
|------|--------|
| `getTexture` is `null` until `canAttachTexture` (painted canvas frame, or LiveKit drawable, or ECS idle black) | Platform |
| Do **not** bind a 1×1 black canvas on decoder create / HLS load / occupancy pause | **Forbidden** |
| `Material` / `GltfNodeModifiers` skip apply while video is unresolved — do not replace GLB maps with map-less unlit/PBR | Platform |
| Occupancy `setMediaEnabled(false)` pauses the element; `ThrottledVideoTexture.stop` does **not** `clearToBlack` | Platform |
| First `drawImage` of decoded pixels fires `onTextureReady` → then bind the canvas map | Platform |

---

## 4. AvatarAttach (1073)

### Verified (docs)

| Rule | Source |
|------|--------|
| Attaches entity to avatar bone / anchor (`anchorPointId`) | entity-positioning — AvatarAttach |
| Optional `avatarId` (wallet); default local player | docs |
| **Overwrites Transform** with pose relative to the avatar; updated every frame | docs |
| Offsets: **parent** entity has AvatarAttach; **child** holds local Transform offset | docs (GP: attach root + rod child) |
| Colliders on attached entities can jitter CCT — often disable physics layer | docs |

### Client implementation law (Tier B)

| Rule | Status |
|------|--------|
| Sample bone world pose from skeleton after mixer update | Verified |
| Write **DCL `iBe` inverse**: `local` so `PE × local = bone` (`Fle` / `getWorldPosition`) | Verified — SDK compose, not Three-display invert |
| Parent to `PlayerEntity` for worker `getWorldPosition` = PE × relative | Verified — SDK nBe path |
| Apply composed world pose under **scene root** (never PE chest +0.88 attach root) | Verified — comment in bridge |
| Sample attach **after** local avatar locomotion/emote that frame | Verified — frame order law |
| After bone sample, **extract** the attach socket + Transform descendants onto the draw root (same as Tween). Pose Groups are not the GPU objects | Verified — plaza `YI → z0 → n0` left-hand catch |

### Explicitly not law

| Invention | Why |
|-----------|-----|
| Worker `rel.pos = boneDcl − PE.pos` for GP fishing `I5e` | Scene-local helper; breaks matrix-relative attach. **Reverted.** Fix line tip only if Explorer getWorldPosition differs — prove first. |

---

## 5. MainCamera + VirtualCamera

### Verified (docs + this client)

| Rule | Source |
|------|--------|
| Scene may bind `MainCamera.virtualCameraEntity` to a VirtualCamera entity | SDK + client bridges |
| Scene may clear bind (`void 0` / empty) to return lens to player | GP `freeRevealCamera` |
| Clear must fully unbind on client (no stale entity id) | Client law — freecam / locomotion |
| VC bind is **local presentation**; freecam orbit state must survive | AGENTS multi-scene camera FocusOwner |

### Client implementation law

| Rule | Status |
|------|--------|
| Treat `virtualCameraEntity` missing / `null` / `0` as unbound | Verified |
| `getMutable().virtualCameraEntity = void 0` → force empty MainCamera put on worker | Verified — bind guard |
| player-frame empty MainCamera → freecam | Verified |

### Open gap

| Gap | Note |
|-----|------|
| Exact lookAt / transition parity for multi-hop reveal cams (GP catch reveal) | Measure Explorer; do not invent offsets |

---

## 6. InputModifier (locomotion freeze)

### Verified

| Rule | Source |
|------|--------|
| Scene may set `disableWalk/Run/Jog/Jump` or `disableAll` | SDK + GP `oa()` / `ra()` |
| Only **primary** FocusOwner applies player-frame IM | AGENTS multi-scene |
| Clear on leave / demote | AGENTS |

GP: `oa()` freezes walk during fight/reveal; `ra()` restores.

---

## 7. Scene UI (react-ecs)

### Verified (client COD + GP reeling)

| Rule | Status |
|------|--------|
| Mount set from worker; Yoga layout in virtual canvas | Client architecture |
| Paint only when mount/layout/visual fingerprints change | Client law |
| Absolute-position movers (reeling bar) may refine without full Yoga | Client perf law |
| UV-only bg updates must not teardown `backgroundImage` (flash) | Client paint law |

Not scene inventions — paint budget under high dirty rates.

---

## 8. GP fishing — scene law only (not client forks)

From Genesis Plaza `bin/index.js` (catalyst), **do not re-encode as client special cases**:

| Event | Scene |
|-------|--------|
| Rod show | `K6e()` → `L1` Visibility true + cast emote |
| Rod hide | `y_()` → Visibility false (leave `JHe`, some reveal paths) |
| Press E | Billboard root + plane child + Visibility + BasicMaterial |
| Missed it | Billboard root + atlas plane + **Scale/Move tweens** (not Visibility) |
| Leave pond | `ihe` → step deactivate + `Ci.onPlayerLeave` → `y_()` + `ra()` |
| Catch reveal | `MainCamera` → reveal VC; `freeRevealCamera` clears |

---

## 9. Checklist before any “scene looks wrong” fix

```text
[ ] Bundle call sites grepped (not guessed)
[ ] Scene law ≤10 lines written down
[ ] Row in this file: Verified | Client convention | Open gap
[ ] Fix is universal platform path (not if GP / if fishing)
[ ] No recover-when-wrong layers
[ ] If Open gap: measure Explorer or stop
```

---

## 10. Current open gaps (do not invent past these)

These three stay **Open** until **one** Explorer capture or **one** unityrenderer commit exists. Measure-only until then. They are **not** required to tag 2.2 (SceneLoop 🟢 does not wait on these goldens).

Named scenes (Genesis Plaza, Genesis CBD, SpaceRunner, Flagtag, NeonScreen, CREATOR Hub) are **guides / repros**, not law. A capture may use any official scene bundle that exercises the API. No scene-name forks.

| # | Gap | Status | What would close it | Forbidden until then |
|---|-----|--------|---------------------|----------------------|
| 1 | **Plane UV vs Unity Explorer golden** — default south V flipped for Three lookAt (−Z). Client convention only. | **Open** | One Explorer capture, or one unityrenderer UV-packing commit, of a dual-face plane + texture | Invented north-V invert, extra UV rolls, Billboard-only flips |
| 2 | **VirtualCamera lookAt** — reveal / multi-hop chain pixel parity (Tween parents must be on the worker store — see Tween law) | **Open** | One Explorer capture of a bound VirtualCamera lookAt / transition | Invented lookAt offsets, iso lifts, scene-named camera forks |
| 3 | **AvatarAttach quaternion** vs Explorer bone sample — play-frame inject closed the timing hole; quat golden still open | **Open** | One Explorer capture, or one unityrenderer bone-sample commit, of attach-local quat | Invented relative-pos hacks, scene-local attach math |

**Closing a gap = one measurement, then one client law change.**

1. Capture Explorer (or cite a unityrenderer commit) for that one API.
2. Promote the row to **Verified** with the measurement cited.
3. Change the client law **once**, universally — any official `bin/scene.js` that uses the API.

Do not close a gap from a named-scene screenshot alone, a “looks better” flip, or a fishing-session trial rotation. Do not change bridge code for these three until the measurement exists.

---

## 11. Tween → Transform (renderer-owned)

Explorer interpolates Tween on the renderer and writes **Transform** on the same engine the scene reads (`m.get(nb).scale.y`, cinematic parents). Host TweenBridge owns interpolation; the guest store must see the live pose on the play-frame (same class as AvatarAttach / PE). Not a scene fork.

**TweenSequence is kernel-owned (ADR-133 / Unity TweenPlugin / Bevy).** Explorers set `ENABLE_SDK_TWEEN_SEQUENCE = false` before bundle eval so `@dcl/ecs` `createTweenSystem` does **not** hop on leftover `TweenState` COMPLETED (that zips plaza `yv` 15×~60ms hops). Scene authors `Tween` (first hop) + `TweenSequence` (rest, `loop` only if TL_RESTART/YOYO). Kernel plays that program at renderer framerate and writes `TweenState` + `Transform`. Rebuild only when the scene dirties Tween/Sequence — do not treat the still-authored first hop as a restart, and do not run a second hop owner.

---

## 12. Scene `/reload` (in-place facade recycle)

### Verified (Unity `ReloadSceneChatCommand` + `ECSReloadScene`)

| Rule | Source |
|------|--------|
| Chat `/reload` recycles the **current parcel** SDK7 scene only | Unity `ReloadSceneChatCommand` |
| Dispose JS + scene ECS + that scene’s draw; keep realm, comms, avatars, other scenes | Unity `DeleteEntityIntention` + `UnloadSceneSystem` |
| Scene definition / content list stay cached | Unity keeps `SceneDefinitionComponent` |
| Live `/reload` does **not** drain wearable / GLB / texture caches | `ICacheCleaner.UnloadCache` is LSD-only |
| Preview hot-reload is the same spine + optional single-hash GLB evict | Unity `TryReloadSceneAsync(ct, sceneId, changedModelSrc)` |

### Client implementation law

| Rule | Status |
|------|--------|
| `/reload` → `World.reloadPrimaryScene` — **not** `teardownScene` / new World | Platform |
| Keep `AssetCache`, PhysX world, player capsule, comms, AOI / neighbors | Platform |
| Drop stale primary PhysX actors only after the new graph cooks | Platform — avoid falling through |
| LSD / preview file-watch: `LocalPreviewHotReload` on localhost realm WS | Platform — Unity `LocalSceneDevelopmentController` |
| `UpdateModel.src` evicts one GLB (path-stable LSD hash); `UpdateScene` refreshes `/about` then recycles | Platform |
