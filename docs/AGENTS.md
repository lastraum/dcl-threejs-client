# AI Agent Onboarding — ThreejsClient

> Read this before touching code. Humans: see [CONTRIBUTING.md](../CONTRIBUTING.md) to claim parity work.

## Reading order

1. **[INTEGRATION.md](./INTEGRATION.md)** — **master parity checklist**: ECS + UI + networking + performance
2. **`src/client/dev/integrationRegistry.ts`** — machine-readable gap matrix (dev panel source)
3. **[CLAIMS.yaml](./CLAIMS.yaml)** — who is already working on what (synced from GitHub `in-progress` issues)
4. **[PROGRESS.md](./PROGRESS.md)** — shipped milestones + narrative history
5. **[DEPLOYMENT.md](./DEPLOYMENT.md)** — build, preview, go-live checklist
6. **[PR_CHECKLIST.md](./PR_CHECKLIST.md)** — required checks before opening a PR

Optional: `CLIENT_UI_LAYOUT.md`, `PLAYER_DESIGN.md`, `AVATAR_DESIGN.md`, `CONTRIBUTOR_TESTING.md`, `TASKS.yaml` (legacy re-arch history only).

## Frozen boundaries — do not refactor casually

| Boundary | Rule |
| -------- | ---- |
| **Shim / scene worker** | `src/shim/worker/sceneWorker.ts`, `createSystemStubs.ts`, `~system/*` RPC — frozen unless claim explicitly targets shim |
| **CRDT wire format** | Keep PUT/APPEND/DELETE + Lamport LWW; do not replace with custom pub/sub |
| **No pub/sub event bus** | Events travel as CRDT components or worker RPC only |
| **Comms outbound chat** | Use `encodeRfc4ChatPacket` in `src/social/dclRfc4Chat.ts` |
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

Raw URLs (default branch `main`):

- `https://raw.githubusercontent.com/lastraum/dcl-threejs-client/main/docs/CLAIMS.yaml`
- `https://raw.githubusercontent.com/lastraum/dcl-threejs-client/main/docs/PROGRESS.md`

Override branch: `?docsBranch=your-branch` or `localStorage.docsBranch`.  
Offline: `?docsGithubFetch=0` uses bundled snapshots (`claimsFallback.ts`, `progressFallback.ts` from `npm run prebuild`).

## Where to start (common areas)

| Area | Entry files |
| ---- | ----------- |
| Input | `src/input/PointerEventsSystem.ts`, `pointerConstants.ts` |
| Avatars | `src/bridge/AvatarAttachBridge.ts`, `AvatarShapeBridge.ts` |
| Media | `src/media/VideoPlayerBridge.ts` |
| Social | `src/social/`, `src/network/comms/` |
| Content | `src/dcl/content/resolveScene.ts` |

## Debug flags

- `?pointerverbose` — pointer flush diagnostics
- `?docsGithubFetch=0` — offline docs snapshots

Prefer real scenes: Genesis Plaza, `rickroll.dcl.eth`, `pizzapizza.dcl.eth`.