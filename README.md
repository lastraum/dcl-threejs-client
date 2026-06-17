# ThreejsClient

A **browser-native Decentraland SDK7 Explorer** — Three.js renderer, Web Worker scene runtime, PhysX, and LiveKit/RFC4 multiplayer. Runs published scene bundles (`bin/index.js`) with CRDT sync, avatars, and an Explorer-style HUD. An alternative to the Unity and Godot explorers, built for the open web.

## Goals

**Web-native scene runtime.** Ship a client that runs real DCL SDK7 scenes in the browser without a game-engine shell — Three.js on the main thread, scene scripts in a worker, content from Catalyst and the content network.

**Performance-first architecture.** The active re-architecture removes redundant engine duplication on the main thread (mirror `Engine()`, `crdt-renderer-push`, stash/nudge machinery). The target path is **projection + encoder**: decode CRDT once, render from a projection, write reserved entities back through an encoder — fewer copies, better frame time.

**SDK7 scene parity.** Match Explorer behavior where creators expect it: correct DCL↔Three.js transforms, PhysX grounding and colliders, pointer and trigger flows, media, avatars, and comms wired to realm/LiveKit patterns. Parity is proven on real scenes (Genesis Plaza, `rickroll.dcl.eth`, `pizzaparty.dcl.eth`), not toy demos.

**Focused scope.** This is not a full replica of the entire Decentraland stack. The priority is **in-scene runtime** plus **social/comms** where already integrated — not rebuilding every platform service or legacy kernel surface.

**Open contribution.** Parity gaps live in the integration registry; contributors self-claim via GitHub issues — see [Community contributions](#community-contributions) below.

## Community contributions

### Who can contribute

- **DCL scene creators and SDK7 developers** — fix parity gaps you hit in real scenes
- **Web / Three.js engineers** — renderer, input, media, comms, content resolution
- **AI-assisted workflow welcome** — same parity matrix, boundaries, and PR rules as humans

### Find and claim work

1. **Dev panel** — `</>` sidebar → **Community** tab: parity gaps (`ecs:Raycast`, `ui:voice-ui`, …) + who is already working on what
2. **Shipped history** — **Shipped** tab (`PROGRESS.md`) and **Full status** tab (complete matrix)
3. **Claim** — file a [**Task claim** issue](https://github.com/lastraum/dcl-threejs-client/issues/new?template=task.yml) with an integration ref; add **`in-progress`** label → syncs to dev panel

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

1. Read **[docs/AGENTS.md](docs/AGENTS.md)** first — frozen boundaries, reading order
2. **One claim per PR** — link your Task claim issue; reference the integration ref in the PR title or body
3. **Update integration status** in `registry.ts` / `integrationRegistry.ts` when parity changes
4. Run through **[docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md)** before requesting review

### Branch and PR basics

| Step | Detail |
| --- | --- |
| Branch | `feat/<integration-ref>-short-description` |
| Build | `npm run build` must pass |
| Smoke test | Load Genesis Plaza or the task's `test_scenes` |
| Checklist | [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md) |
| Workflow | [CONTRIBUTING.md](CONTRIBUTING.md) |

Draft PRs early if scope is uncertain.

### Good first areas

Pick a **Community tab** gap with a clear test scene — e.g. `ecs:TriggerArea`, `ecs:Raycast`, `ecs:AudioSource`, `ui:voice-ui`. Avoid shim/worker paths unless you have read [docs/AGENTS.md](docs/AGENTS.md) and coordinated on CRDT boundaries.

### Public docs

Live claims and progress load from [github.com/lastraum/dcl-threejs-client](https://github.com/lastraum/dcl-threejs-client) (`main`). Dev panel (`</>`) fetches `CLAIMS.yaml` and `PROGRESS.md` at runtime. Details: [docs/AGENTS.md](docs/AGENTS.md).

### Expectations

- **Focused PRs** — minimal diffs; no drive-by refactors outside the task scope
- **Parity on real scenes** — Genesis Plaza, `rickroll.dcl.eth`, `pizzaparty.dcl.eth` (not toy demos)
- **Respect frozen boundaries** — do not rewrite shim/worker, CRDT wire format, or comms chat encoding without an explicit task and maintainer discussion ([docs/AGENTS.md](docs/AGENTS.md))
- **Constructive review** — match existing code style; call out known gaps in the integration registry

## Quick start

```bash
npm install && npm run dev
```

Production build: `npm run build` → static SPA in `dist/`. Preview: `npm run preview`.

## Docs

| Doc | Purpose |
| --- | ------- |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | Master checklist — ECS + UI + networking + performance |
| [docs/CONTRIBUTOR_TESTING.md](docs/CONTRIBUTOR_TESTING.md) | **Deploy your own world** for immediate test iterations |
| [docs/AGENTS.md](docs/AGENTS.md) | AI/human onboarding — boundaries, reading order |
| [docs/CLAIMS.yaml](docs/CLAIMS.yaml) | Community claims (synced from GitHub issues) |
| [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md) | Required checks before opening a PR |
| [docs/PROGRESS.md](docs/PROGRESS.md) | Milestone log (live in dev panel from public repo) |
| [docs/REPO_MANAGEMENT.md](docs/REPO_MANAGEMENT.md) | Public repo migration and branch strategy |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to claim tasks and submit PRs |

Deploy: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). Dev overlay: `</>` sidebar → Community claims + parity gaps + `PROGRESS.md` from GitHub `dev-latest`.
