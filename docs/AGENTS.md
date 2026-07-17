# AI Agent Onboarding — ThreejsClient

> Read this before touching code. Humans: see [CONTRIBUTING.md](../CONTRIBUTING.md) to claim parity work.

## Reading order

1. **[PROGRESS.md](./PROGRESS.md)** — latest release, what’s next, shipped history  
2. **[INTEGRATION.md](./INTEGRATION.md)** + **`src/client/dev/integrationRegistry.ts`** — parity matrix  
3. **[CLAIMS.yaml](./CLAIMS.yaml)** — who is already working on what  
4. **[ARCHITECTURE.md](./ARCHITECTURE.md)** — scene I/O model + debt  
5. **[DEPLOYMENT.md](./DEPLOYMENT.md)** — build / preview / go-live  
6. **[PR_CHECKLIST.md](./PR_CHECKLIST.md)** — required checks before PR  
7. **[CONTRIBUTOR_TESTING.md](./CONTRIBUTOR_TESTING.md)** — test matrix  

Also: [REPO_MANAGEMENT.md](./REPO_MANAGEMENT.md) (branches/release), [IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md) (historical phases), [TASKS.yaml](./TASKS.yaml) (re-arch history only).

## Frozen boundaries — do not refactor casually

| Boundary | Rule |
| -------- | ---- |
| **Shim / scene worker** | `src/shim/worker/sceneWorker.ts`, `createSystemStubs.ts`, `~system/*` RPC — frozen unless claim explicitly targets shim |
| **CRDT wire format** | Keep PUT/APPEND/DELETE + Lamport LWW; do not replace with custom pub/sub |
| **No pub/sub event bus** | Events travel as CRDT components or worker RPC only |
| **Comms outbound chat** | Use `encodeRfc4ChatPacket` in `src/social/dclRfc4Chat.ts` |
| **2D vs 3D chat** | 2D shell = `SocialChatDock` (FAB); 3D in-play = `ChatPanel` / ClientShell — do not mix UX |
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
| Media | `src/media/VideoPlayerBridge.ts` |
| Social | `src/social/`, `src/network/comms/` |
| Content | `src/dcl/content/resolveScene.ts` |

## Debug flags

- `?pointerverbose` — pointer flush diagnostics
- `?docsGithubFetch=0` — offline docs snapshots

Prefer real scenes: Genesis Plaza, `rickroll.dcl.eth`, `pizzapizza.dcl.eth`.
