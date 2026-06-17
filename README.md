# ThreejsClient

A **browser-native Decentraland SDK7 Explorer** — Three.js renderer, Web Worker scene runtime, PhysX, and LiveKit/RFC4 multiplayer. Runs published scene bundles (`bin/index.js`) with CRDT sync, avatars, and an Explorer-style HUD. An alternative to the Unity and Godot explorers, built for the open web.

## Goals

**Web-native scene runtime.** Ship a client that runs real DCL SDK7 scenes in the browser without a game-engine shell — Three.js on the main thread, scene scripts in a worker, content from Catalyst and the content network.

**Performance-first architecture.** The active re-architecture removes redundant engine duplication on the main thread (mirror `Engine()`, `crdt-renderer-push`, stash/nudge machinery). The target path is **projection + encoder**: decode CRDT once, render from a projection, write reserved entities back through an encoder — fewer copies, better frame time.

**SDK7 scene parity.** Match Explorer behavior where creators expect it: correct DCL↔Three.js transforms, PhysX grounding and colliders, pointer and trigger flows, media, avatars, and comms wired to realm/LiveKit patterns. Parity is proven on real scenes (Genesis Plaza, `rickroll.dcl.eth`, `pizzaparty.dcl.eth`), not toy demos.

**Focused scope.** This is not a full replica of the entire Decentraland stack. The priority is **in-scene runtime** plus **social/comms** where already integrated — not rebuilding every platform service or legacy kernel surface.

**Open contribution.** Work is tracked in [docs/TASKS.yaml](docs/TASKS.yaml) and open to DCL creators, SDK7 developers, and AI-assisted contributors — see [Community contributions](#community-contributions) below.

## Community contributions

### Who can contribute

- **DCL scene creators and SDK7 developers** — fix parity gaps you hit in real scenes
- **Web / Three.js engineers** — renderer, input, media, comms, content resolution
- **AI-assisted workflow welcome** — same task registry, boundaries, and PR rules as humans

### Find and claim work

1. Browse **[docs/TASKS.yaml](docs/TASKS.yaml)** — look for `status: open` (skip `maintainer_only: true` unless you coordinated with a maintainer)
2. **Dev panel** — open the `</>` sidebar in the running client; it loads the live backlog from GitHub
3. **Claim** — set `owner` + `status: in_progress` in YAML and open a PR, or file a [**Task claim** issue](.github/ISSUE_TEMPLATE/task.yml) to propose or reserve work

Full claim workflow: [CONTRIBUTING.md](CONTRIBUTING.md).

### Test with your own scene (recommended)

Deploy a **minimal SDK7 scene** to **your own `.dcl.eth` world** for fast, isolated testing. World deployments are **live immediately** after a successful deploy — load `/yourname.dcl.eth` in the client (dev or preview). Full guide: **[docs/CONTRIBUTOR_TESTING.md](docs/CONTRIBUTOR_TESTING.md)**.

```bash
# In your SDK7 scene project
npm run build && dcl deploy --target-content yourname.dcl.eth

# In ThreejsClient
npm run dev
# → http://localhost:5173/yourname.dcl.eth
```

Still smoke **Genesis Plaza** or **RickRoll** for heavy-scene parity; use **your world** to prove task-specific behavior.

### AI-assisted contributors

1. Read **[docs/AGENTS.md](docs/AGENTS.md)** first — frozen boundaries, reading order, re-arch gates
2. **One task per PR** — stay within the task's `files` list; reference the task `id` in the PR title or body
3. **Update TASKS.yaml** in the same PR (`owner`, `status`, notes if scope shifts)
4. Run through **[docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md)** before requesting review

### Branch and PR basics

| Step | Detail |
| --- | --- |
| Branch | `feat/<task-id>-short-description` |
| Build | `npm run build` must pass |
| Smoke test | Load Genesis Plaza or the task's `test_scenes` |
| Checklist | [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md) |
| Workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |

Draft PRs early if scope is uncertain.

### Good first tasks vs re-arch work

| | Good starters | Re-arch gates (e7–e10) |
| --- | --- | --- |
| **Tracks** | input, media, rendering, content, ui | `re-arch` phase 3 |
| **Examples** | `gltf-node-shadows`, `trigger-area-volume`, `raycast-scene-api`, `video-player-bridge` | `rearch-e7-pointer-same-tick` → e8 → e9 → e10 |
| **Requirements** | No `maintainer_only`; read task `acceptance_criteria` + `test_scenes` | Read [docs/REARCHITECTURE_PLAN.md](docs/REARCHITECTURE_PLAN.md) + [docs/AGENTS.md](docs/AGENTS.md); maintainer review required |

Re-arch tasks e7–e10 are sequential and touch the CRDT consumer path — they need prior context on projection, encoder, and pointer same-tick gates. Prefer non–re-arch open tasks for a first contribution.

### Public repo migration

The repo is **private** during active re-arch integration on branch `redo/threejs-projection-arch`. A public cut is planned after phase 3 completes (e10 merged to `main`, `package.json` opened, branch protection enabled). Details: [docs/REPO_MANAGEMENT.md](docs/REPO_MANAGEMENT.md).

### Expectations

- **Focused PRs** — minimal diffs; no drive-by refactors outside the task scope
- **Parity on real scenes** — Genesis Plaza, `rickroll.dcl.eth`, `pizzaparty.dcl.eth` (not toy demos)
- **Respect frozen boundaries** — do not rewrite shim/worker, CRDT wire format, or comms chat encoding without an explicit task and maintainer discussion ([docs/AGENTS.md](docs/AGENTS.md))
- **Constructive review** — match existing code style; call out known gaps (`status: partial` in TASKS.yaml)

## Quick start

```bash
npm install && npm run dev
```

Production build: `npm run build` → static SPA in `dist/`. Preview: `npm run preview`.

## Docs

| Doc | Purpose |
| --- | ------- |
| [docs/INTEGRATION_STATUS.md](docs/INTEGRATION_STATUS.md) | Master checklist — ECS + UI + networking + performance |
| [docs/CONTRIBUTOR_TESTING.md](docs/CONTRIBUTOR_TESTING.md) | **Deploy your own world** for immediate test iterations |
| [docs/AGENTS.md](docs/AGENTS.md) | AI/human onboarding — boundaries, reading order |
| [docs/TASKS.yaml](docs/TASKS.yaml) | Community task backlog (claim → PR) |
| [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md) | Required checks before opening a PR |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Milestone log and re-arch narrative |
| [docs/REARCHITECTURE_PLAN.md](docs/REARCHITECTURE_PLAN.md) | Renderer re-arch scope and phase gates |
| [docs/REPO_MANAGEMENT.md](docs/REPO_MANAGEMENT.md) | Public repo migration and branch strategy |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to claim tasks and submit PRs |

Deploy: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Dev overlay: `</>` sidebar → roadmap loaded from GitHub `TASKS.yaml`.
