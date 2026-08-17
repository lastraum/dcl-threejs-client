# ThreejsClient

A **browser-native Decentraland SDK7 Explorer** — Three.js renderer, Web Worker scene runtime, PhysX, and LiveKit/RFC4 multiplayer. Runs published scene bundles (`bin/index.js`) with CRDT sync, avatars, and an Explorer-style HUD. Built for the open web.

**Current release:** **v2.0.0** (host world + city walk). Latest tagged on `main`. QA continues on `dev-latest`.

[Goals](#goals) · [Contributions](#contributions) · [Environments](#environments) · [Pets](#pets) · [Shaders](#shaders)

## Goals

**Web-native scene runtime.** Ship a client that runs real DCL SDK7 scenes in the browser without a game-engine shell — Three.js on the main thread, scene scripts in a worker, content from Catalyst and the content network.

**Performance-first architecture.** **v2.0** ships the host world: decode CRDT once onto a projection, present from the host store, run official `scene.js` in a guest VM. No second main-thread SDK engine, no `crdt-renderer-push`. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**SDK7 scene parity.** Match Explorer behavior where creators expect it: correct DCL↔Three.js transforms, PhysX grounding and colliders, pointer and trigger flows, media, avatars, and comms wired to realm/LiveKit patterns. Parity is proven on real scenes (Genesis Plaza, `rickroll.dcl.eth`, `pizzaparty.dcl.eth`), not toy demos.

**Focused scope.** This is not a full replica of the entire Decentraland stack. The priority is **in-scene runtime** plus **social/comms** where already integrated — not rebuilding every platform service or legacy kernel surface.

**Open contribution.** Parity gaps live in the integration registry; contributors self-claim via GitHub issues — see [Contributions](#contributions) below.

**Non-commercial license.** Free to use, fork, and contribute; commercial / for-profit use needs written permission — see [License](#license).

## Contributions

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
| [docs/CREATOR_ANALYTICS.md](docs/CREATOR_ANALYTICS.md) | Public place analytics (landing stats, ingest, Supabase) |
| [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) | Historical phase plan |
| [docs/PR_CHECKLIST.md](docs/PR_CHECKLIST.md) | Required checks before PR |
| [docs/REPO_MANAGEMENT.md](docs/REPO_MANAGEMENT.md) | Branches, release, community |
| [docs/TASKS.yaml](docs/TASKS.yaml) | Re-arch history (not a pickup queue) |
| [docs/CLAIMS.yaml](docs/CLAIMS.yaml) | Community claims (synced from GitHub issues) |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to claim tasks and submit PRs |
| [LICENSE](LICENSE) | Non-commercial license |

Dev overlay: `</>` sidebar → Community claims + parity gaps + `PROGRESS.md` from GitHub `dev-latest`.

## Environments

ThreejsClient-only backdrop for **worlds** and parcels: sky, ground package, and (for water biomes) ocean waves. Unity/Godot Explorer ignore these fields — they only affect this client.

### How to set the biome

**1. `scene.json` (recommended for worlds)** — ship with your deploy:

```json
{
  "environment": {
    "kind": "island"
  }
}
```

Or a string: `"environment": "island"`.

**2. URL override (dev / QA)** — wins over `scene.json` for the session:

```text
http://localhost:5173/yourworld.dcl.eth?environment=island
http://localhost:5173/yourworld.dcl.eth?env=desert
```

**3. Terrain editor** — open **`/editor`** (or top nav **Terrain**) → biome icon rail → writes `environment.kind` into the project `scene.json`. Play and editor use the same `buildParcelLandscape` path.

### Biome kinds

| `kind` | Look | Ocean |
| --- | --- | --- |
| `none` | Void authoring sky (local/blank default) | No |
| `genesis` | Genesis sky + default floor tiles (parcel/world default when unset) | No |
| `island` | Circular shore + beach disc | **Yes** (FFT waves) |
| `water` | Open ocean (no land disc) | **Yes** |
| `mountains` | Parcel decoration + haze; shore water | **Yes** |
| `land` | Solid color infinite plane | No |
| `forest` | Empty-land trees/rocks scatter | No |
| `desert` | Gold dunes + outer rocks + dust | No |
| `space` | Stars / nebula sky + platform | No |

**Water is tied to the biome.** `island`, `water`, and `mountains` turn the ocean **on** automatically. You do **not** need `?water=1`.

Defaults when `environment` is omitted: **worlds + parcels → `genesis`**; local/blank projects → `none`.

### Optional knobs

```json
{
  "environment": {
    "kind": "island",
    "water": {
      "amplitude": 0.05,
      "windSpeed": 18,
      "waterDeep": "#52b9e5",
      "fft": true
    },
    "desert": { "sandColor": "#d4a858" },
    "land": { "groundColor": "#3d6b2e" },
    "space": { "starDensity": 0.7 },
    "disableSun": false,
    "disableMoon": false
  }
}
```

| Field | Purpose |
| --- | --- |
| `environment.water` | FFT ocean look (amplitude, wind, colors, `fft: false` → Water.js fallback). Ignored by other explorers. |
| `environment.water.enabled` | Explicit kill/force. Default follows biome (`showWater`). Set `false` to dry an island; set `true` only to force water on a dry biome. |
| `environment.desert` / `.land` / `.space` / `.mountains` | Biome-specific look (colors, haze, stars, …) |

### Dev URL flags

| Query | Effect |
| --- | --- |
| `?environment=island` / `?env=island` | Force biome for this load |
| `?water=0` / `?noWater` / `?disableWater` | Kill ocean even on island |
| `?water=1` | Force ocean on a **non**-water biome |
| `?fftOcean=0` | Use Water.js instead of GPGPU FFT |
| `?oceanAmplitude=0.05` | Wave energy (debug) |
| `?oceanWind=20` | Wind speed (debug) |
| `?disableSun=1` / `?disableMoon=1` | Hide celestial bodies |

Example world smoke:

```bash
npm run dev
# → http://localhost:5173/yourname.dcl.eth?environment=island
# Console: [ocean] biome=island showWater=true ... fftOcean=true
```

### Terrain editor (sculpt + biomes)

Open **`/editor`** for height / splat / Ez Grass brushes and the floating biome dock. Biome rail writes `environment.kind`; island/water also expose FFTOCEAN controls under `environment.water`. Latest notes: [docs/PROGRESS.md](docs/PROGRESS.md).

## Pets

Pets are companions that follow **you**. Anyone in the same place on this client can see them. Official Explorer does not show them, and scenes do not spawn them — you pick one from the HUD.

### Open Pets

1. Click **Labs** on the left rail (the 2×2 grid).
2. Click **Pets**.

You get a list of companions you already own (built-ins plus anything you imported or added from the Barn).

### Browse the Pet Barn

1. In the Pets panel, click **Barn**.
2. The **Shop** tab is the public catalog (name, thumbnail, walking vs flying).
3. Click **Add** on a card to download that pet into your local collection.
4. Close the Barn and turn the pet **on** in your Pets list.

You can also **Publish** your own GLB from the Barn (thumbnail is compressed for you). Listings show up in the shop after the catalog updates.

### Use a pet

- Toggle it **on** in the Pets list — it appears at your feet (walkers) or above you (flyers).
- Walk or run — it follows. Stand still long enough and it sits, then idles AFK.
- Right-click the pet in the world for the radial menu (dismiss, settings, …).
- Import a GLB from your machine with the upload control in the Pets panel if you do not want the Barn.

Nothing to add to `scene.json`. Other people using this client in the same place see your pet automatically.

## Shaders

There is no `tjs` in the scene. **Creating the Tag is the call.**

```ts
// load only (does not fire)
Tags.createOrReplace(engine.RootEntity, {
  tags: [
    'tjs.shader(ice, assets/shaders/IceAbility.js)',
    'tjs.shader(cinder, assets/shaders/MeteorAbility.js)'
  ]
})

// fire — any time, any entity
pointerEventsSystem.onPointerDown(
  { entity: button, opts: { button: InputAction.IA_POINTER, hoverText: 'Cast Ice' } },
  function () {
    const ox = 42, oy = 0, oz = 46
    const dx = 0.83, dy = 0, dz = -0.55
    const distance = 14
    Tags.createOrReplace(engine.addEntity(), {
      tags: [`tjs.ice.spawn(${ox}, ${oy}, ${oz}, ${dx}, ${dy}, ${dz}, ${distance})`]
    })
  }
)
```

That **is** `ability.spawn(origin, direction, distance)`. `${}` is just JS inside the string.

Add the spawn Tag **anywhere you want to trigger** the shader — a pointer callback, a timer, another system, not only a click.

This client only — Unity / Bevy do not treat Tags as a shader bus.

| You write | Role |
| --- | --- |
| `tjs.shader(ice, assets/shaders/IceAbility.js)` | Load that file as `ice` |
| `` tjs.ice.spawn(${ox}, ${oy}, ${oz}, ${dx}, ${dy}, ${dz}, ${distance}) `` | `spawn(origin, direction, distance)` |

Copies: VFX scene `assets/shaders/`.

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
