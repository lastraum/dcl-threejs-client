# LightSource parity (ThreejsClient)

Concise tracker for ECS `LightSource` rendering vs Decentraland Explorer / Unity Foundation Client.

## Implemented

### Quick wins (`LightSourceSync.ts`, `pbColor.ts`)

- Intensity: `max(0, candelas / 4000)` — **not** raw candelas pass-through. Three.js 0.175 accepts candelas in the API, but without verified side-by-side tuning, raw DCL values (~16000 cd default) overexpose the scene. `/4000` matches pre-parity Explorer brightness (default → Three.js intensity **4**).
- Range clamp: `min(range, pow(intensity, 0.25))` when `range >= 0`; auto range uses raw ECS candelas
- Spot target at local `(0, 0, -1)`, `decay = 2`
- Default to point light when `type` is missing

### LightManager (`src/rendering/LightManager.ts`)

Runs each frame from `World` using the active camera position. Does **not** create lights — `LightSourceSync` still owns creation; the manager only toggles visibility and shadow flags.

| Rule | Value |
|------|-------|
| Distance cull | Lights farther than **40 m** from the camera are hidden |
| Quality tier cap | Nearest **N** lights within range stay active: Low **4**, Medium **6**, High **10** |
| Spot shadow cap | Up to **3** nearest eligible spot lights with `shadow: true` get `castShadow` |

Lights carry `userData.lightSource` (`ecsActive`, `wantsShadow`, `isSpot`) set during sync.

### Quality hook (`src/rendering/RenderQualitySettings.ts`)

- `renderQuality` singleton — `setTier('low' \| 'medium' \| 'high')` or `setOptions({ tier })`
- Limits read at runtime by `LightManager`; tier changes apply on the next frame
- **Tone mapping exposure** per tier (`TONE_MAPPING_EXPOSURE`: 1.0 / 1.06 / 1.12) — applied in `SceneHost`
- **Shadow map size** per tier (`SHADOW_MAP_SIZE`: 512 / 1024 / 1024)
- Debug panel (**Help → Render quality → Light culling tier**) wired to the same store

**Programmatic change:**

```ts
import { renderQuality, RenderQualityTier } from './rendering/RenderQualitySettings'

renderQuality.setTier(RenderQualityTier.High)
```

### Sun / hybrid environment (`EnvironmentSystem.ts`)

Hardcoded Genesis sun/moon/hemi tuned to work **with** ECS LightSources (not replace them):

- Base sun: `DirectionalLight` × SunCycle24h **m_Intensity** (peak **2.72**, `SUN_BRIGHTNESS` **1.0**) + color ramp
- Moon fill: **`moonLightIntensity()`** × `MOON_BRIGHTNESS` **1.15** × user moon slider; cool tint; light follows camera focus at night
- **Moon disc:** billboarded `SkyboxMoon.png` on night celestial arc; Unity `_Moon_Mask_Size` ~**0.16** overnight (was broken sky-sphere UV → invisible)
- **Trilight ambient (Unity `UpdateIndirectLight`):** HemisphereLight sky+ground + **AmbientLight equator**
- Soft **directional sun shadows** (day); skydome sun disc visual-only (small warm halo)
- **User tuning:** defaults **52 / 70 / 52 / 50**; **Reset lighting** button
- **Azimuth parity ([#15](https://github.com/lastraum/dcl-threejs-client/pull/15))** · skybox authority scene → session → auto

### Tone mapping + exposure (`SceneHost.ts`, `EnvironmentSystem.ts`)

- `ACESFilmicToneMapping` + tier exposure from `RenderQualitySettings`
- Day: `tierExposure × sunExposureMultiplier(user exposure)`
- Night: `tierExposure × moonExposureMultiplier(user moon exposure)` (replaces fixed `NIGHT_EXPOSURE_BOOST` only multiplier)
- `outputColorSpace = SRGBColorSpace`
- Re-subscribes on tier change via `renderQuality`

### Scene GLTF emissives (`sceneGltfEmissives.ts`) — 🟡 partial

- DCL parity model: emissive **color** clamped to [0,1] per channel; **intensity** separate (KHR `emissive_strength`, 2–80+)
- Named neon mats (`LightLED`, etc.) → black albedo, `toneMapped: false`, hue in `emissive` × `emissiveIntensity`
- Baked floor/wall emissive maps skipped
- **Outstanding:** not all scenes/materials match Explorer; emissive-map neon path; wearables use separate `avatar/materials.ts`

### Global shadow pipeline (`SceneHost.ts`, `spotLightShadow.ts`, `LightManager.ts`)

- `renderer.shadowMap.enabled = true`, `PCFSoftShadowMap`
- Safe budget: max **3** spot shadow maps (same cap as `LightManager` shadow slots)
- Spot shadow tuning: map size from tier, `bias -0.0001`, `normalBias 0.015`, `radius 2`, camera far = light distance
- **`receiveShadow = true`** on scene meshes: `MaterialApplier`, primitives in `ThreeBridge`, GLTF clones on spawn

## Outstanding (full Explorer parity)

| Item | Notes |
|------|-------|
| **Physically-correct candelas** | Tone mapping + exposure are in place; **keep `/4000`** until side-by-side verified against Explorer. Then remove scaling in `pbColor.ts`. |
| **`shadowMaskTexture`** | ECS field exists on `PBLightSource`; not applied. Explorer uses it for caustics / shaped shadows — needs custom shadow-map or projector material path in Three.js. |
| **`shadow` on point lights** | Only spot lights are considered for the shadow cap; point-light shadows not implemented (6-face cubemap cost). |
| **Directional LightSource** | **Not in current `PBLightSource` protobuf** (point + spot only). Revisit when SDK schema adds a directional variant. |
| **Exact Explorer tier numbers** | Tier limits (4 / 6 / 10) are reasonable parity targets; Unity Explorer source values not verified byte-for-byte — adjust after side-by-side profiling. |
| **Player vs camera cull origin** | Culling uses **camera** position (works in orbit mode). Explorer may use avatar position in some cases. |
| **Directional sun shadows** | Soft sun shadows enabled (day); refine cascade extent / bias if acne or peter-panning. |
| **Sun/hemi intensity vs Explorer** | Trilight + anim peak 2.72; **Reset lighting** if old localStorage sliders persist. |
| **GltfNodeModifiers castShadows** | Per-node GLTF shadow flags not wired; Material `castShadows` is. |
| **Per-layer cloud tints** | Explorer uses per-layer gradients; we use one global `uCloudsColor` for all cubemap layers. |
| **Graphics settings stubs** | Preferences panel MSAA/bloom/shadows/resolution — UI only, not wired to renderer. |
| **Custom skybox + user sliders** | Worlds with `/about` cubemap hide GenesisSky; lighting sliders don't affect custom backgrounds. |

## Key files

- `src/bridge/LightSourceSync.ts` — ECS → Three.js light sync
- `src/rendering/LightManager.ts` — distance + quality culling
- `src/rendering/RenderQualitySettings.ts` — tier limits, exposure, shadow map size
- `src/rendering/SceneHost.ts` — renderer tone mapping + shadow map enable
- `src/rendering/spotLightShadow.ts` — spot shadow map tuning
- `src/environment/EnvironmentSystem.ts` — sun/moon/hemi + hybrid ECS scale
- `src/core/World.ts` — per-frame `lightManager.update` then `environment.update`

## How to test

1. **Genesis Plaza** — FPS should stay stable (LightManager culling). Scene should not look blown out; sun dims as you walk among many lights.
2. **Render quality tier** — Help → Render quality; switch Low/Medium/High and confirm active light count + shadow quality change.
3. **Spot shadows** — Scene with `LightSource` spot + `shadow: true`; stand near lit geometry; up to 3 nearest spots should cast soft shadows on meshes.
4. **Orbit mode** — `?orbit` URL; culling follows camera, sun hybrid still applies.
5. **Day/night** — Skybox panel time slider; sun/moon ramps without fighting ECS lights at night.
