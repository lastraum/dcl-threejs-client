# COD fan-out — outdoor lighting parity (Explorer softer yellow)

**Date:** 2026-08-08  
**Branch:** `feat/lighting-parity`  
**Bar:** AGENTS.md COD · Explorer platform law (not scene-name looks)  
**Agents:** explore (client light graph) · explore (materials/shadows/IBL) · research (unity-explorer assets) · plan  

---

## Platform law (one paragraph)

Outdoor lighting is **Explorer parity**, not a creative grade. Midday Genesis must read as **warm key + soft Trilight fill**: sun from the **directional color ramp** (noon ≈ `(1.0, 0.931, 0.692)` / `#FFEDB0`, prefab default `#FFF4D6`), ambient as **sky + equator + ground** with Explorer noon hues, soft directional contact where quality allows, and ACES exposure kept in a soft outdoor range. **Do not invent** full Unity GI, cascade shadows, or per-frame PMREM. Prefer re-tuning knobs already in `EnvironmentSystem` / `skyGradients` / quality shadows. Material outdoor soften (ECS already) for GLTF is a measured follow-up after light color/intensity.

---

## Diagnosis (why we feel whiter / harsher)

| Layer | ThreejsClient (midday defaults) | Explorer (`unity-explorer`) | Effect |
|-------|----------------------------------|-----------------------------|--------|
| Sun **color** | Gradient noon `(1, 0.931, 0.692)` — already warm | `#FFEDB0` / prefab `#FFF4D6` | **Not** the main white bug |
| Sun **intensity** | Peak anim **2.72** × mul ≈0.92 → **~2.5** | Prefab intensity **1** (+ same anim; units differ) | Harsh specular / chalk |
| Trilight sky | `(0.519, 0.679, 0.738)` | Match | OK |
| Trilight **equator** | **`(0.55, 0.72, 0.82)` cool cyan** | **`(0.732, 0.649, 0.787)` lavender** | **Washes yellow → white** |
| Trilight **ground** | **`(0.25, 0.35, 0.28)` green-grey** | **`(0.585, 0.102, 0.091)` dark red** | Wrong bounce |
| Fill stack | Hemi **0.42** + Ambient equator **0.48** × mul | Trilight | Cool equator dominates |
| Tone map | ACES + exposure ~**1.09** (medium) | URP + soft outdoor | OK if lights balanced |
| IBL | **No** `scene.environment` / PMREM | Skybox → cubemap IBL | Hard metals, no soft sky bounce |
| Shadows | Medium **PCF hard**; soft only high/ultra | Soft directional | Harder contact = harsher |
| Materials | ECS outdoor soften; **GLTF skips** | Unity outdoor lit | Chrome plaza GLBs |

Construct defaults (`sun 0xffffff`, cool hemi/equator) are overwritten every frame — fix **gradients / intensity**, not construct colors.

### Client light graph (files)

- `src/environment/EnvironmentSystem.ts` — sun/moon/hemi/equator apply  
- `src/environment/skyGradients.ts` — TOD color ramps  
- `src/environment/skyboxTime.ts` — `SUN_BRIGHTNESS`, hemi/equator intensities  
- `src/environment/sunCycleSampler.ts` — anim intensity (peak 2.72)  
- `src/rendering/SceneHost.ts` — ACES + sRGB + shadow map type  
- `src/rendering/SunEnvironmentSettings.ts` — player/creator sliders  
- `src/bridge/material/pbrApply.ts` — ECS outdoor soften  
- `src/rendering/LandscapeAssetSanitizer.ts` — GLTF sanitize (no outdoor soften)

### Explorer sources (verified)

- [SkyboxRenderController.cs](https://github.com/decentraland/unity-explorer/blob/dev/Explorer/Assets/DCL/SkyBox/SkyboxRenderController.cs) — Trilight + ramps  
- [Directional Light.prefab](https://github.com/decentraland/unity-explorer/blob/dev/Explorer/Assets/DCL/SkyBox/Directional%20Light.prefab) — `#FFF4D6`, intensity 1, soft shadows  
- [SkyboxRenderController.prefab](https://github.com/decentraland/unity-explorer/blob/dev/Explorer/Assets/DCL/SkyBox/Prefab/SkyboxRenderController.prefab) — gradient keys  
- [Skybox Control docs](https://docs.decentraland.org/creator/scenes-sdk7/interactivity/skybox-control) — TOD affects light hue + direction  

Kelvin **6570** on the light is **not applied** (`UseColorTemperature = false`); feel comes from RGB ramps.

---

## Ranked actions

| # | Priority | Action | Status |
|---|----------|--------|--------|
| ① | **P0** | Re-key **`indirectEquator` / `indirectGround`** from Explorer prefab (full day cycle); noon lavender + dark red | **Implemented** (`skyGradients.ts`) |
| ② | **P0** | Default `sceneSunLight` **52→48** (softer key); **keep full 0–100 Scene sun light knob** in settings | **Implemented** (`SunEnvironmentSettings.ts`) |
| ③ | **P1** | Soft shadows on **medium** (`PCFSoftShadowMap`) — perf-gate plaza | Pending |
| ④ | **P1** | Share ECS outdoor PBR soften with scene GLTF materials | Pending |
| ⑤ | **P2** | Cheap outdoor IBL (static/low-rate PMREM → `scene.environment`, low intensity) | Pending |
| ⑥ | **P2** | Exposure tier trim only after light balance | Pending |

---

## Kill-list (do not re-add)

- Full Unity GI / light probes / lightmaps  
- Cascade shadow maps  
- Per-frame sky PMREM every TOD tick  
- Extra fake bounce directionals  
- Scene-name / parcel forks for “Genesis yellow”  
- Changing sky **visual** ramps to fix mesh lighting  
- Pure white sun “because simpler”  
- Literal Unity intensity 1 without ACES/ambient context  
- Heavy LUT / film grain as yellow substitute  

---

## Pass/fail QA — Genesis Plaza midday

**Setup:** Genesis plaza, graphics **Medium**, **Reset lighting**, skybox **fixed 12:00**. Side-by-side with Explorer same place/time/facing.

| Check | PASS | FAIL |
|-------|------|------|
| Key color | Warm yellow cream on lit ground/props | Flat studio white |
| Shadow / fill | Soft lavender on verticals, warm bounce | Ice-cyan clinical fill |
| Contrast | Soft outdoor, controlled speculars | Chalk + mirror spikes |
| Contact shadows | Soft edges (high; medium after P1) | Razor hard only |
| Sky vs mesh | Dome + **meshes** both warm | Pretty sky, white scene |
| Night 23:59 | Readable purple fill | Red mud / crushed black |
| Perf | Medium plaza still playable | Soft shadow/IBL tanks FPS |

---

## First PR slice (smallest needle)

```text
fix(lighting): Explorer noon trilight equator/ground hues
```

**Only:** `skyGradients.ts` midday equator + ground (+ smooth neighbors).  
**Out of scope:** intensity, exposure, soft shadows, IBL, GLTF metal.

**Why first:** Directional is already yellow; **cool cyan equator washes yellow to white**. Data-only, no perf path.

---

## Related path

- Branch: `feat/lighting-parity` (from `dev-latest` @ lighting COD start)  
- Follow-ups: brightness rebalance → medium soft shadows → GLTF outdoor PBR → cheap IBL  
