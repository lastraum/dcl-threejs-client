# AI Agent Onboarding — ThreejsClient

> Read this before touching code. Humans: see [CONTRIBUTING.md](../CONTRIBUTING.md) to claim parity work.

## Execution standard (always)

Treat every multi-scene, performance, and continuity task as **ship-or-iterate AAA quality** — not “good enough for a demo.” Guiding bar:

> Build as if this were a first-person experience at the level of the most recent Call of Duty titles: visually complete, systems coherent, no accidental unload voids, no silent regressions. Prefer fix-until-proven over leave-a-TODO. Fan out investigation, harsh self-critique, measure, then land the continuity path.

### Multi-scene continuity (non-negotiable)

| Rule | Detail |
|------|--------|
| **No unload on parcel walk** | Promote = handoff + sticky demote only. **Never** `disposeSecondariesOnly` + seamless `jumpIn` for stand-on-parcel promote. |
| **Rebind origin on promote** | `comms.bindSceneTarget(newPrimary)` **before** `restoreGenesisFeet`. Missing this warps soft-route (old local + new base → wrong parcel like -135,107) and voids CBD. |
| **Prior primary stays resident** | Demote keeps mesh graph sticky as **secondary** (muted scripts) regardless of parcel count. Tertiary only via leave-ring / cap pressure. Re-promote unpauses. **Never** `system.dispose()` into void. |
| **Freeze hold pin** | `disableAllHoldFeet` only for intentional `InputModifier.disableAll`. Never pin for colliders-ready or multi-scene thrash. Stall auto-recover if keys held + free + feet stuck. |
| **Secondary scripts 100%** | Live secondary `onUpdate` every frame (`secondaryTickIntervalMs = 0`), hard-capped (≤3). |
| **Secondary FocusOwner mute** | No video, audio, scene UI, privileged pointers/nav — `FocusPolicy = 'secondary'`. |
| **Primary FocusOwner** | Only primary owns UI / media / inputs / locomotion. |
| **Tertiary residents** | Only when **leave 16m live ring** or **secondary-cap pressure** (prefer non-sticky). Scripts OFF + LOD. Re-enter → scripts on only (**no GLB reload**). |
| **No parcel-size gate** | Parcel count never refuses secondary boot or picks tertiary. Budget = live radius + hard secondary cap + boot concurrency. |
| **Tertiary composites** | Roads / empty / AOI shells fill the world without workers; distance-budgeted. |
| **Default ground everywhere** | Default parcel GLB on **all** non-road AOI parcels. Procedural trees/rocks **only** on vacant / catalyst-empty. |
| **Freecam always free** | Only feet-primary FocusOwner applies InputModifier / MainCamera / video / UI. Demoted secondaries never apply player-frame. Clear freeze on demote + promote handoff. |
| **Camera FocusOwner (platform)** | Freecam yaw/pitch/dist are **player state** (survive primary swap). Scene VirtualCamera drives the lens only while `isActive()` — not MainCamera bind lag. VC must never rewrite freecam orbit; handoff snaps boom to feet only. |
| **AvatarModifier FocusOwner** | Only primary may hide avatars / force CameraMode. Demote clears hide + forced camera; secondary never syncs AvatarModifierArea (prevents “became a vending machine”). |
| **No matrix freeze on tertiary** | Tertiary = scripts off only; never freeze TRS matrices (sky-GLB bug after retarget). |
| **FPS bar** | Target **30–60 FPS** always; **60 FPS** on high/custom. Cap live scripts; LOD tertiary when far / under cap. Exclusive secondary boot (no chain thrash). |

If a change makes the world go blank on neighbor step, **it is a P0 bug** — reverse or fix before shipping.

## Reading order

1. **[PROGRESS.md](./PROGRESS.md)** — latest release / RC, what’s next, shipped history  
2. **[MULTI_SCENE_CONTINUITY.md](./MULTI_SCENE_CONTINUITY.md)** — FocusOwner · sticky demote · colliders · AOI (branch `feat/aoi-focus-owner`)  
3. **[INTEGRATION.md](./INTEGRATION.md)** + **`src/client/dev/integrationRegistry.ts`** — parity matrix  
3b. **[COLLIDER_MOTION_POLICY.md](./COLLIDER_MOTION_POLICY.md)** — PhysX PART vs ROOT (v1.5)  
4. **[CLAIMS.yaml](./CLAIMS.yaml)** — who is already working on what  
5. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — scene I/O model + debt  
6. **[DEPLOYMENT.md](./DEPLOYMENT.md)** — build / preview / go-live  
7. **[PR_CHECKLIST.md](./PR_CHECKLIST.md)** — required checks before PR  
8. **[CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md)** — test matrix  

Also: [REPO_MANAGEMENT.md](./REPO_MANAGEMENT.md) (branches/release), [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) (historical phases), [TASKS.yaml](./TASKS.yaml) (re-arch history only).

## Frozen boundaries — do not refactor casually

| Boundary | Rule |
| -------- | ---- |
| **Shim / scene worker** | `src/shim/worker/sceneWorker.ts`, `createSystemStubs.ts`, `~system/*` RPC — frozen unless claim explicitly targets shim |
| **CRDT wire format** | Keep PUT/APPEND/DELETE + Lamport LWW; do not replace with custom pub/sub |
| **No pub/sub event bus** | Events travel as CRDT components or worker RPC only |
| **Comms outbound chat** | Use `encodeRfc4ChatPacket` in `src/social/dclRfc4Chat.ts` |
| **2D vs 3D chat** | **2D** shell = `SocialChatDock` bottom-right FAB expand/collapse. **3D** in-play = `ChatPanel` **bottom-left** (+ sidebar / Enter; mobile-only left FAB). Do not move 3D chat to the right. |
| **Elevated spawn** | Stage PE before script; `settleSpawnOntoFloor` preferNear authored Y — never accept roof as floor |
| **DCL transform space** | Logical sim/comms in DCL LH meters; display conversion at render boundary only (`src/bridge/dclTransform.ts`) |

## Claim flow (community-driven)

1. Find a gap — integration ref like `ecs:Raycast` (dev panel **Community** tab lists `none` / `stub` / `partial` items).
2. Check [in-progress issues](https://github.com/lastraum/dcl-threejs-client/issues?q=is%3Aopen+label%3Ain-progress) and `CLAIMS.yaml` — do not duplicate.
3. Open a [Task claim issue](https://github.com/lastraum/dcl-threejs-client/issues/new?template=task.yml) with the integration ref.
4. `in-progress` label → bot syncs `CLAIMS.yaml` → dev panel shows the claim.
5. PR links issue; on merge update `registry.ts` / `integrationRegistry.ts` + `PROGRESS.md`; close issue.

## Dev progress panel (`</>`)

| Tab | Source |
| --- | ------ |
| Community | Parity gaps (`integrationRegistry.ts`) + claims (`CLAIMS.yaml` from GitHub) |
| Full status | Complete integration matrix |
| Shipped | `docs/PROGRESS.md` on `main` |

Raw URLs (default branch `dev-latest`):

- `https://raw.githubusercontent.com/lastraum/dcl-threejs-client/main/docs/CLAIMS.yaml`
- `https://raw.githubusercontent.com/lastraum/dcl-threejs-client/main/docs/PROGRESS.md`

Override branch: `?docsBranch=your-branch` or `localStorage.docsBranch`.  
Offline: `?docsGithubFetch=0` shows placeholder notices only (not live progress). Live progress/claims always fetch from GitHub `dev-latest`. Client version is always `package.json` (`APP_VERSION`).

## Where to start (common areas)

| Area | Entry files |
| ---- | ----------- |
| Input | `src/input/PointerEventsSystem.ts`, `pointerConstants.ts` |
| Avatars | `src/avatar/`, `src/bridge/AvatarAttachBridge.ts`, `AvatarShapeBridge.ts` |
| Backpack | `src/client/ui/settings/BackpackView.ts`, `backpackWearables.ts`, `src/avatar/slots.ts` |
| Media | `src/media/VideoPlayerBridge.ts` |
| Social | `src/social/`, `src/network/comms/` |
| Terrain editor | `src/editor/TerrainEditorWorkspace.ts`, `src/editor/ui/TerrainSculptPanel.ts`, `sceneEnvironmentIO.ts` |
| Landscape biomes | `src/dcl/landscape/Systems/RenderGroundSystem.ts`, `DesertGoldGround.ts`, `LandColorGround.ts`, `src/environment/*Defaults.ts` |
| Content | `src/dcl/content/resolveScene.ts` |

## Debug flags

- `?pointerverbose` — pointer flush diagnostics
- `?gltfloadstate` / `?gltfloadingverbose` — host→worker `GltfContainerLoadingState` (SpaceRunner InputModifier freeze/release)
- `?docsGithubFetch=0` — offline docs snapshots

Prefer real scenes: Genesis Plaza, `rickroll.dcl.eth`, `pizzapizza.dcl.eth`, `deadsurge.dcl.eth` (large combat / VC / PE attach), `spacerunner.dcl.eth` (load freeze → Gltf FINISHED release).
