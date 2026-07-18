# ThreejsClient

A **browser-native Decentraland SDK7 Explorer** — Three.js renderer, Web Worker scene runtime, PhysX, and LiveKit/RFC4 multiplayer. Runs published scene bundles (`bin/index.js`) with CRDT sync, avatars, and an Explorer-style HUD. An alternative to the Unity and Godot explorers, built for the open web.

## Goals

**Web-native scene runtime.** Ship a client that runs real DCL SDK7 scenes in the browser without a game-engine shell — Three.js on the main thread, scene scripts in a worker, content from Catalyst and the content network.

**Performance-first architecture.** The active re-architecture removes redundant engine duplication on the main thread (mirror `Engine()`, `crdt-renderer-push`, stash/nudge machinery). The target path is **projection + encoder**: decode CRDT once, render from a projection, write reserved entities back through an encoder — fewer copies, better frame time.

**SDK7 scene parity.** Match Explorer behavior where creators expect it: correct DCL↔Three.js transforms, PhysX grounding and colliders, pointer and trigger flows, media, avatars, and comms wired to realm/LiveKit patterns. Parity is proven on real scenes (Genesis Plaza, `rickroll.dcl.eth`, `pizzaparty.dcl.eth`), not toy demos.

**Focused scope.** This is not a full replica of the entire Decentraland stack. The priority is **in-scene runtime** plus **social/comms** where already integrated — not rebuilding every platform service or legacy kernel surface.

**Open contribution.** Parity gaps live in the integration registry; contributors self-claim via GitHub issues — see [Community contributions](#community-contributions) below.

**Non-commercial license.** Free to use, fork, and contribute; commercial / for-profit use needs written permission — see [License](#license).

## Community contributions

### Who can contribute

- **DCL scene creators and SDK7 developers** — fix parity gaps you hit in real scenes
- **Web / Three.js engineers** — renderer, input, media, comms, content resolution
- **AI-assisted workflow welcome** — same parity matrix, boundaries, and PR rules as humans

### Find and claim work

1. **Dev panel** — `</>` sidebar → **Community** tab: parity gaps (`ecs:Raycast`, spatial voice, …) + who is already working on what
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

Pick a **Community tab** gap with a clear test scene — e.g. `ecs:TriggerArea`, `ecs:Raycast`, `ecs:AudioSource`, spatial voice. Avoid shim/worker paths unless you have read [docs/AGENTS.md](docs/AGENTS.md) and coordinated on CRDT boundaries.

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
| [docs/PROGRESS.md](docs/PROGRESS.md) | Milestone log + what’s next (live in dev panel) |
| [docs/INTEGRATION.md](docs/INTEGRATION.md) | Parity checklist — ECS + UI + networking + performance |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Scene I/O model + tech debt |
| [docs/AGENTS.md](docs/AGENTS.md) | AI/human onboarding |
| [docs/CONTRIBUTOR_TESTING.md](docs/CONTRIBUTOR_TESTING.md) | Deploy your own world for test iterations |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Build, host, smoke |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Historical phase plan |
| [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md) | Required checks before PR |
| [docs/REPO_MANAGEMENT.md](docs/REPO_MANAGEMENT.md) | Branches, release, community |
| [docs/TASKS.yaml](docs/TASKS.yaml) | Re-arch history (not a pickup queue) |
| [docs/CLAIMS.yaml](docs/CLAIMS.yaml) | Community claims (synced from GitHub issues) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to claim tasks and submit PRs |
| [LICENSE](LICENSE) | Non-commercial license |

Dev overlay: `</>` sidebar → Community claims + parity gaps + `PROGRESS.md` from GitHub `dev-latest`.

## Terrain editor & landscape biomes

Open **`/editor`** (or top nav **Terrain**) for the in-browser sculpt workspace:

- Height / splat / Ez Grass brushes, floating dock + flyouts  
- **Biomes** via icon rail → writes `scene.json` `environment.kind`  
- **Desert** — dunes, outer rocks, dust/tumbleweeds (`environment.desert`)  
- **Land** — solid color plane under the scene (`environment.land.groundColor`)  
- **Island / water** — FFTOCEAN knobs (`environment.water`)  
- Editor preview uses the **same** `buildParcelLandscape` path as play  

See [docs/PROGRESS.md](docs/PROGRESS.md) for the latest milestone notes.

## Credits

- **FFT ocean / waves** — GPGPU Phillips-spectrum water ported from [gioeledallapozza/FFTOCEAN](https://github.com/gioeledallapozza/FFTOCEAN). Scene knobs: `scene.json` → `environment.water` (ThreejsClient-only; ignored by Unity/Godot Explorer).

## License

This project is licensed under the **[ThreejsClient Non-Commercial License](LICENSE)**.

| You may | You may not (without written permission) |
| --- | --- |
| Use, copy, and modify the Software for non-commercial purposes | Sell the Software or a fork, or charge for access to it |
| Fork any branch and open pull requests / issues | Offer paid hosting, SaaS, or a paid product built primarily on this Software |
| Redistribute with attribution under the same terms | Use it primarily to generate revenue (ads, subscriptions, paid features, etc.) |

The license applies to the **entire repository** — **all branches, tags, commits, and releases** — and to any fork or derivative based on any of them. Contributing does **not** grant commercial rights.

For commercial or for-profit use, obtain **prior written permission** from the copyright holder(s). Full terms: **[LICENSE](LICENSE)**.
