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
| Docs UV corner order with **L–R compensation** for DCL→Three X reflection | Client convention (plaza JUMP IN / atlas) — documented in code; Explorer golden TBD |
| Marquee / flipbook special cases stay on their own packing | Client law for those UV patterns |

### Open gap

| Gap | Note |
|-----|------|
| Press_e upside-down under stock lookAt | Likely **plane UV × Three lookAt −Z** mismatch vs Unity plane front, **not** a Billboard mode bug. Close via Explorer capture or Unity plane facing docs — **not** Billboard forks. |

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
| Apply to private `__mesh_*` leaves and Gltf meshes when component present | Verified — needed for private clones |
| Do **not** invent scale rewrites on show/hide | Forbidden (broke missed-it Scale tweens) |
| Do **not** force-show fishing rods ignoring Visibility | Forbidden (reverted) |
| Visibility puts must not starve behind slow peel (same class as Transform motion) | Client COD drain policy |

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
| Write **matrix-relative** Transform: `playerWorld * relative ≈ boneWorld` | Verified — Tier B + docs |
| Parent to `PlayerEntity` for worker `getWorldPosition` = PE × relative | Verified — SDK nBe path |
| Apply composed world pose under **scene root** (never PE chest +0.88 attach root) | Verified — comment in bridge |
| Sample attach **after** local avatar locomotion/emote that frame | Verified — frame order law |

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

1. **Plane texture under BM_ALL lookAt** vs Unity Explorer (press_e orientation).  
2. **Explorer AvatarAttach / getWorldPosition** exact quaternion vs our matrix-relative (line tip).  
3. **Reveal VirtualCamera** multi-entity lookAt chain pixel parity.

Closing any gap = one Explorer measurement or one unityrenderer commit, then one client law change.
