# ThreejsClient

A **browser-native Decentraland SDK7 Explorer** — Three.js renderer, Web Worker scene runtime, PhysX, and LiveKit/RFC4 multiplayer. Runs published scene bundles (`bin/index.js`) with CRDT sync, avatars, and an Explorer-style HUD. Built for the open web.

**Current release:** **v2.2.0** (one guest clock / SceneLoop). **v2.1.0** was local preview + this-client shaders. **v2.0.0** was host world + city walk. Latest tagged on `main`. QA continues on `dev-latest`.

[Goals](#goals) · [Contributions](#contributions) · [Local preview](#local-preview) · [Environments](#environments) · [Pets](#pets) · [Shaders](#shaders)

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

To play the scene **before** you deploy, use **[Local preview](#local-preview)** — start Explorer Play, then swap the host to this client.

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

## Local preview

Play an unpublished SDK7 scene in this client. Start the official **Bevy Explorer** preview so `sdk-commands` / Creator Hub is serving on your machine, then point **this** client at the same preview server.

1. In the scene project, start Play the usual way:
   - Creator Hub → **Play**, or
   - `npm start` (`@dcl/sdk-commands`)
2. Explorer opens (Bevy), typically something like:

```text
https://decentraland.org/play/?realm=http://127.0.0.1:8000
```

3. Change **only the site** to this client. Keep the `realm` / `origin` query if the port is not `8000`.

| You want | Open |
| --- | --- |
| Local Vite | `http://localhost:5173/localpreview` |
| Staging | `https://dev.decentraland.social/localpreview` |
| Production | `https://decentraland.social/localpreview` |

Same scene, other port:

```text
http://localhost:5173/localpreview?origin=http://127.0.0.1:8000
https://dev.decentraland.social/localpreview?port=8001
```

`/preview` is the same route as `/localpreview`. Default preview origin is `http://127.0.0.1:8000`.

The tab jumps **straight into play** (no 2D landing). Scene save / Hub hot reload recycles the parcel in place.

**Two tabs for multiplayer.** Open the same `/localpreview` URL again (or Incognito). The extra tab is a guest in the preview `ws-room`. Prod LiveKit is not used.

Leave the scene `npm start` / Hub Play running. Closing it stops `/about` and this client cannot load the scene.

## Shaders

Scenes drive this client's shaders and cameras with one mirrored custom component named **`tjs`**. `kind` is a string: `shader`, `texture`, `camera`, `projection`. Other explorers ignore unknown custom components, so a published SDK7 scene that defines `tjs` stays valid.

Copy this spec once. **Field order must match.** Skip any field on `tjs.create` you do not use — the SDK fills zeros / empty / false.

### Declare `tjs`

```ts
import {
  engine,
  Transform,
  VirtualCamera,
  Schemas
} from '@dcl/sdk/ecs'
import { Color4, Quaternion, Vector3 } from '@dcl/sdk/math'

const tjs = engine.defineComponent('tjs', {
  kind: Schemas.String,
  name: Schemas.String,
  sync: Schemas.Boolean,
  enabled: Schemas.Boolean,
  path: Schemas.String,
  ox: Schemas.Float,
  oy: Schemas.Float,
  oz: Schemas.Float,
  dx: Schemas.Float,
  dy: Schemas.Float,
  dz: Schemas.Float,
  dist: Schemas.Float,
  camera: Schemas.Entity,
  layers: Schemas.String,
  background: Schemas.Color4,
  fov: Schemas.Float
})
```

A `kind: 'shader'` row **loads** when the component appears (even with `enabled: false`). `path` is the shader file. `name` is the export that file exposes (whatever that file calls it). Already-warmed shaders are not fetched again on `/reload` or HMR.

Cast pose fields are only for shaders that fire from a point toward a target. Omit them otherwise (`0` / empty means unused: origin and direction come from the entity Transform, distance is 32 m). Same for `layers`, `background`, `fov`, `camera`: skip them on rows that do not use them.

- `ox` — origin X (where the effect starts, scene meters)
- `oy` — origin Y
- `oz` — origin Z
- `dx` — direction X (toward the target, usually normalized)
- `dy` — direction Y
- `dz` — direction Z
- `dist` — how far it travels, in meters (`0` / omit → 32)

### Shader example

Load once (`enabled: false`). That fetches the file. `enabled: true` is the trigger — the file is not fetched again. Set `enabled: false` to stop / to fire again on the same entity.

```ts
const fx = engine.addEntity()
tjs.create(fx, {
  kind: 'shader',
  name: 'geyser',
  path: 'assets/shaders/GeyserAbility.js',
  enabled: false
})

function cast(
  origin: ReturnType<typeof Vector3.create>,
  target: { x: number; y: number; z: number }
) {
  const dx = target.x - origin.x
  const dz = target.z - origin.z
  const distance = Math.sqrt(dx * dx + dz * dz) || 1
  const row = tjs.getMutable(fx)
  row.ox = origin.x
  row.oy = origin.y
  row.oz = origin.z
  row.dx = dx / distance
  row.dy = 0
  row.dz = dz / distance
  row.dist = distance
  row.enabled = true
}

function stop() {
  tjs.getMutable(fx).enabled = false
}

cast(Vector3.create(42, 0, 46), Vector3.create(54, 0, 38))
stop()
cast(Vector3.create(42, 0, 46), Vector3.create(60, 0, 40))
```

Set `sync: true` on the row if other ThreejsClient sessions should see that shot.

Need two of the same effect at once? Create a second entity. The file is already warm, so skip `path` on the extra row.

### Cameras and projection screens

Each **`kind: 'camera'`** lens is a full extra render of the world every frame (512×512 RT). Two lenses means the city is drawn three times (your view plus both feeds). More cameras and screens cost FPS. Keep the count small.

Draw bits live on the **camera** row (comma-separated string), not the screen:

| Token | What the lens sees |
| --- | --- |
| `0` | Buildings, GLBs, MeshRenderer, terrain |
| `1` | Avatars (local, remote, AvatarShape) |
| `2` | SFX / `tjs` shaders |
| omit / `""` | All three (`0,1,2`) |

Examples: `"0,1,2"` full feed, `"1"` avatars only, `"0,2"` world + SFX (no avatars).

**Lens** — `Transform` + SDK `VirtualCamera` + `tjs` `kind: 'camera'`. Do **not** set `tjs.camera` on this entity (that field is only for screens). Viewpoint is `VirtualCamera.lookAtEntity`, or Transform **+Z** if omitted. `enabled` typically starts `true`.

```ts
const lookAt = engine.addEntity()
Transform.create(lookAt, { position: Vector3.create(54, 0, 38) })

const cam = engine.addEntity()
Transform.create(cam, {
  position: Vector3.create(54, 5, 52),
  rotation: Quaternion.fromEulerDegrees(-20, 0, 0)
})
VirtualCamera.create(cam, { lookAtEntity: lookAt })
tjs.create(cam, {
  kind: 'camera',
  enabled: true,
  layers: '0,1,2',
  fov: 40,
  background: Color4.create(0, 0, 0, 1)
})
```

`fov` is vertical degrees (default `60`, clamped 1–170). `background` is the RT clear / empty-feed color (default black).

**World screen** — `Transform` + `tjs` `kind: 'projection'` with **`camera: cam`** (the lens **entity**, not a dummy number). Do **not** put `MeshRenderer`, SDK `Material`, or `MeshCollider` on the screen. This client draws the plane from the Transform.

```ts
const screen = engine.addEntity()
Transform.create(screen, {
  position: Vector3.create(46, 2.2, 42),
  rotation: Quaternion.fromEulerDegrees(0, 35, 0),
  scale: Vector3.create(4.2, 2.6, 1)
})
tjs.create(screen, {
  kind: 'projection',
  enabled: true,
  camera: cam
})
```

Toggle the picture on the **projection** (leave the camera `enabled`):

```ts
const row = tjs.getMutable(screen)
row.enabled = !row.enabled
```

**UI screen** — same lens, no second `kind: 'projection'`. On a `UiEntity` background, set `texture.src` to `tjs:${cam}`. This client never file-loads that src. If the lens is not up yet, the panel stays on `uiBackground.color` until it is.

```ts
<UiEntity
  uiTransform={{ width: 420, height: 236 }}
  uiBackground={{
    color: Color4.create(0, 0, 0, 1),
    textureMode: 'stretch',
    texture: { src: `tjs:${cam}` }
  }}
/>
```

| Field | Role |
| --- | --- |
| `kind: 'shader'` | Loads when the row appears. `enabled: true` fires it. |
| `path` | Shader file. |
| `name` | Export in that file (the function it exposes). |
| `ox` | Origin X. Where the effect starts (scene meters). Optional. |
| `oy` | Origin Y. Optional. |
| `oz` | Origin Z. Optional. |
| `dx` | Direction X. Toward the target (usually normalized). Optional. |
| `dy` | Direction Y. Optional. |
| `dz` | Direction Z. Optional. |
| `dist` | Travel distance in meters. Optional. `0` / omit → 32 m. |
| `sync: true` | That one-shot is shared with other ThreejsClient sessions. |
| `kind: 'camera'` | Same entity as `Transform` + `VirtualCamera`. `layers`, `fov`, `background` live here. Do not set `camera`. |
| `layers` | Camera only. `"0,1,2"` string. Empty / omit = all. |
| `fov` | Camera only. Vertical FOV, default 60. |
| `background` | Color4 clear for empty feeds. Default black. |
| `kind: 'projection'` + `camera` | Host-drawn world plane. `camera` is the **lens entity**. |
| UI `texture.src` `tjs:${cam}` | Same RT on a UiBackground. No file loader. |
| `kind: 'texture'` | Reserved. Unused for cameras. |

## Credits

- **Kenney** ([@KenneyNL](https://x.com/KenneyNL)) — CC0 3D kits (city, roads, cars). [kenney.nl](https://kenney.nl)
- **Chiro Visuals** ([@chirovisuals](https://x.com/chirovisuals)) — Three.js ability VFX shaders. [LinearAbiltyCastingThreeJS](https://github.com/achrefelouafi/LinearAbiltyCastingThreeJS)
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
