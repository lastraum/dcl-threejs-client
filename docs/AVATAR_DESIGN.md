# Avatar System — Design (Phase 4)

> **Short answer:** Yes — you can **build a DCL avatar at runtime in Three.js** without exporting a `.vrm` file first. Explorer and the-forge preview both do live composition; Forge only **serializes to VRM** when you want a portable file (Hyperfy upload, etc.).

---

## Two avatar modes

| Mode | Source | Runtime approach |
|------|--------|------------------|
| **DCL profile** | Catalyst wearables + `body_shape` | Compose GLBs in Three.js (Explorer / Forge preview pattern) |
| **Custom VRM** | User URL or Forge export | Load `.vrm` via `@pixiv/three-vrm` (Hyperfy `createVRMFactory`) |

Both attach to the **PhysX capsule** from `PlayerSystem` — avatar is a child of the player root, not the physics driver.

---

## DCL runtime composition (Three.js)

This is **not** “instantiate VRM from wearables.” It is:

1. **Fetch profile** — `GET {peer}/lambdas/profiles/{wallet}` → equipped URNs, skin/hair/eye colors, body shape
2. **Resolve assets** — `POST {peer}/content/entities/active` → GLB hashes per wearable
3. **Slot resolution (ADR-239)** — port `the-forge/web-app/src/lib/wearable-preview/babylon/slots.ts`
4. **Load GLBs** — `GLTFLoader` + existing `AssetCache` / content URLs
5. **Base mesh trim** — port `body.ts`: hide `*_basemesh` when skin / category wearables cover them
6. **Wearable layer** — one skinned GLB per slot, shared skeleton (`Avatar_*` bones)
7. **Facial features** — port `face.ts`: eye/mouth/eyebrow **textures** on body_shape masks
8. **Tint** — skin/hair hex on materials matching `*skin*` / `*hair*` names

**Reference (Babylon, same logic):**

```
the-forge/web-app/src/lib/wearable-preview/babylon/
  render.ts    → orchestration
  slots.ts     → ADR-239
  wearable.ts  → GLB load + tint
  body.ts      → basemesh visibility
  face.ts      → facial masks
  config.ts    → profile → PreviewConfig
```

**Output:** a single Three.js `Group` / skinned hierarchy — no `.vrm` on disk.

---

## When you still want VRM export

Forge **`exportVRMByPatching()`** runs **after** composition:

- Maps `Avatar_*` bones → VRM humanoid (`VRMC_vrm`)
- Produces a Blob for download / Hyperfy / Colyseus

Use cases:

- Custom avatar URL for Hyperfy worlds
- Caching a composed look as one file
- NFT / forge rewards pipeline

**Not required** for displaying a DCL avatar in ThreejsClient.

---

## Custom VRM path (expansion)

Port from Hyperfy:

- `hyperfy/src/core/systems/ClientLoader.js` — VRM load
- `hyperfy/src/core/extras/createVRMFactory.js` — humanoid, emotes, LOD

User equips a `.vrm` URL instead of (or overriding) DCL profile composition.

---

## Suggested implementation order

| Phase | Work |
|-------|------|
| **4a** | Profile fetch + slot resolution + `body_shape` + one wearable category |
| **4b** | Full ADR-239 hiding + skin/hair + facial features |
| **4c** | Emotes (`Animator` / GLB clips on shared skeleton) |
| **4d** | Optional VRM loader + Forge export hook |
| **4e** | `AvatarShape` ECS component → pick DCL vs custom VRM |
| **4f-a** | Local custom VRM library (IndexedDB) + Backpack equip |
| **4f-b** | DAV wire protocol + P2P VRM transfer over scene comms |
| **4f-c** | Remote VRM rendering + locomotion for peers |
| **4f-d** | Profile emotes on VRM (Mixamo retarget) + polish |

---

## Phase 4f — Custom VRM multiplayer

### 4f-a — Local library + Backpack

- Users import `.vrm` files via drag-and-drop on the Backpack **Custom VRMs** tab.
- Bytes are stored in **IndexedDB** (`VrmLibrary` / `vrmByteCache`) keyed by SHA-256 content hash.
- Equip state is persisted per wallet (`vrmEquipStorage`).
- `LocalAvatar` loads the equipped VRM via `VrmAvatar.fromBytes()` instead of DCL composition when equipped.

### 4f-b — DAV P2P transfer

Custom VRM bytes are **not** uploaded to Catalyst. Peers exchange them over scene comms using **DAV** (Decentraland Avatar VRM v1):

| Piece | Location |
|-------|----------|
| Protocol | `src/avatar/vrm/dclClientAvatar.ts` |
| Orchestration | `src/avatar/vrm/VrmPeerSync.ts` |
| RFC4 route | `Rfc4Router` → `scene_id = dcl.client.avatar` |
| Publish | `CommsService.sendSceneAvatarVrm()` |

**Message flow:**

1. **Announce** — on equip or scene connect: content hash (32 B) + byte size.
2. **FetchRequest** — receiver asks provider for bytes.
3. **FetchBegin / FetchChunk / FetchEnd** — chunked stream (~12 KB/chunk for LiveKit limits).
4. **Clear** — unequip custom VRM.
5. **FetchError** — `not_found`, `oversize`, `busy` (auto-retry on `busy`).

### 4f-c — Remote rendering

- Received peer bytes live in a **RAM-only** cache (`vrmRamCache.ts`) — never written to remote IndexedDB.
- `RemoteAvatarManager` tracks `vrmContentHash` per peer; shows placeholder until bytes arrive.
- On ready: `VrmAvatar` + `VrmLocomotionAnimations` (same forward walk/jog/run as local).
- Race with DCL compose: `reloadPeerAvatar()` cancels in-flight load and swaps to VRM when announce/bytes arrive.
- `vrm.humanoid.autoUpdateHumanBones = false` during animation — mixer drives bones directly.

### 4f-d — Emotes + polish

- Profile emotes retarget from GLB skeleton → VRM humanoid via `retargetGltfClipToVrm()` (`mixamoRetarget.ts`).
- Local: `LocalAvatar.playEmote()`; remote: `RemoteAvatarManager.applyPeerEmote()`.
- Stale DAV fetches time out after 120 s (`VrmPeerSync.gcStaleFetches()` in the frame loop).
- RAM cache cleared on world dispose.

---

## Relation to ECS

Explorer exposes **`AvatarShape`**, **`PlayerIdentityData`**, etc. For MVP:

- Local player: **client-composed mesh** + PhysX capsule
- Mirror: update **`PlayerEntity` / `CameraEntity`** transforms (Phase 2c)
- Remote players (Phase 5): sync transforms + compose avatar from profile or VRM URL

---

## Related docs

- [`PLAYER_DESIGN.md`](./PLAYER_DESIGN.md) — PhysX capsule (avatar parent)
- Forge: `the-forge/documentation/VRM_EXPORT_WORKING_DATA.md`
- Hyperfy: `dcl-avatar-hyperfy/hyperfy/src/core/extras/createVRMFactory.js`
