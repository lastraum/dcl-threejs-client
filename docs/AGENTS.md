# AI Agent Onboarding — ThreejsClient

> Read this before touching code. Humans: see [CONTRIBUTING.md](../CONTRIBUTING.md) to claim tasks.

## Reading order (8 docs)

1. **[TASKS.yaml](./TASKS.yaml)** — pick-up backlog; claim by setting `owner` + `status: in_progress`
2. **[INTEGRATION_STATUS.md](./INTEGRATION_STATUS.md)** — **master checklist**: every ECS component + client UI + networking + performance
3. **[REARCHITECTURE_PLAN.md](./REARCHITECTURE_PLAN.md)** — renderer re-arch scope (what moves, what stays frozen)
4. **[PROGRESS.md](./PROGRESS.md)** — shipped milestones + narrative history
5. **[ECS_COMPONENTS.md](./ECS_COMPONENTS.md)** — detailed ECS tables with component IDs
6. **[IMPLEMENTATION_PLAN.md](./IMPLEMENTATION_PLAN.md)** — phase roadmap
7. **[DEPLOYMENT.md](./DEPLOYMENT.md)** — build, preview, go-live checklist
8. **[PR_CHECKLIST.md](./PR_CHECKLIST.md)** — required checks before opening a PR

Optional deep dives: `CLIENT_UI_LAYOUT.md`, `PLAYER_DESIGN.md`, `AVATAR_DESIGN.md`, `CONTRIBUTOR_TESTING.md`, `.cursor/rules/comms-architecture.mdc`.

## Frozen boundaries — do not refactor casually

| Boundary | Rule |
| -------- | ---- |
| **Shim / scene worker** | `src/shim/worker/sceneWorker.ts`, `createSystemStubs.ts`, `~system/*` RPC — frozen unless task explicitly targets shim |
| **CRDT wire format** | Keep PUT/APPEND/DELETE + Lamport LWW; do not replace with custom pub/sub |
| **No pub/sub event bus** | Events travel as CRDT components or worker RPC only |
| **Comms outbound chat** | Use `encodeRfc4ChatPacket` in `src/social/dclRfc4Chat.ts` — not Unity-style Packet header for LiveKit text |
| **DCL transform space** | Logical sim/comms in DCL LH meters; display conversion at render boundary only (`src/bridge/dclTransform.ts`) |

## Re-arch constraints (branch `redo/threejs-projection-arch`)

- **Explorer frozen, renderer rebuilt** — content resolution, comms, avatars, physics, identity, UI shell stay; main-thread CRDT consumer changes.
- **Phase 3 gate:** e7 pointer same-tick via `crdt-response` ✅ · e8 push channel deleted ✅ → e9 drop mirror `Engine()` → e10 perf.
- Tasks marked `maintainer_only: true` in TASKS.yaml need maintainer review before merge.
- Pointer delivery uses encoder stash + `crdt-round-trip-nudge` (push channel removed in e8).

## Task registry

- **Source of truth:** [docs/TASKS.yaml](./TASKS.yaml)
- **Dev panel:** fetches raw YAML from GitHub at runtime (see below); offline fallback from bundled snapshot.
- **Claim flow:** issue or PR that sets `owner`, `status: in_progress`, links `id`, updates acceptance criteria checkboxes in PR body.

## Dev progress panel — TASKS.yaml fetch

At runtime the `</>` dev panel loads tasks from GitHub:

```
https://raw.githubusercontent.com/lastraum/ThreejsClient/<branch>/docs/TASKS.yaml
```

- Default branch: `redo/threejs-projection-arch` (override via `?tasksBranch=main` or `localStorage.tasksBranch`).
- Parsed client-side with the `yaml` package.
- On fetch/parse failure: falls back to `src/client/dev/tasksFallback.ts` (regenerated on `npm run prebuild` from local TASKS.yaml).
- Version/changelog tab still reads `progressData.ts` + `package.json` (not TASKS.yaml).

To refresh the offline snapshot without a network fetch: `npm run prebuild`.

## Where to start (common tasks)

| Track | Entry files |
| ----- | ----------- |
| Input | `src/input/PointerEventsSystem.ts`, `pointerConstants.ts` |
| Re-arch | `src/core/systems/SceneScriptSystem.ts`, `src/bridge/CrdtProjection.ts` |
| Media | `src/media/VideoPlayerBridge.ts`, `WebVideoPlayer.ts` |
| Social | `src/social/`, `src/network/comms/` |
| Content | `src/dcl/content/resolveScene.ts` |

## Debug flags (re-arch validation)

URL query flags:

- `?pointerverbose` — pointer flush + crdt-response byte counts on click/nudge

Prefer real scenes: Genesis Plaza, `rickroll.dcl.eth`, `pizzaparty.dcl.eth`.
