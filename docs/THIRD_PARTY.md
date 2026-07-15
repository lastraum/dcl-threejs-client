# Third-party code

Attributions for significant third-party sources ported or vendored into this client.

## FFTOCEAN — GPGPU FFT water

**Source:** [gioeledallapozza/FFTOCEAN](https://github.com/gioeledallapozza/FFTOCEAN)

**Used for:** Open-ocean and island water when the landscape profile shows water (`island` / `water` biomes) and WebGL2 is available.

**Port location:**

| Upstream | This repo |
| --- | --- |
| `src/gpgpu/useOceanGPGPU.js` + butterfly / spectrum shaders | [`src/environment/fftOcean/OceanGPGPU.ts`](../src/environment/fftOcean/OceanGPGPU.ts), [`shaders.ts`](../src/environment/fftOcean/shaders.ts) |
| `src/geometry/lod/ClipmapGeometry.js` | [`src/environment/fftOcean/ClipmapGeometry.ts`](../src/environment/fftOcean/ClipmapGeometry.ts) |
| `src/materials/OceanMaterial.js` + ocean GLSL | [`src/environment/FftOceanWater.ts`](../src/environment/FftOceanWater.ts), ocean shaders in `shaders.ts` |

**License:** See the upstream repository.

**Scene control:** Creators may tune the port via ThreejsClient-only `scene.json` → `environment.water` (ignored by Unity/Godot Explorer). Defaults live in [`fftOceanDefaults.ts`](../src/environment/fftOcean/fftOceanDefaults.ts). URL query (`?fftOcean=0`, `?fftResolution=…`, …) overrides scene settings for local debug.

Example:

```json
{
  "environment": {
    "kind": "island",
    "water": {
      "fft": true,
      "fftResolution": 128,
      "amplitude": 0.012,
      "windSpeed": 18,
      "windDirection": { "x": 0.4, "z": 0.8 },
      "choppyScale": 2.0,
      "waterDeep": "#52b9e5",
      "waterShallow": "#59cdff"
    }
  }
}
```

Fields: see `SceneWaterConfig` in [`src/dcl/content/types.ts`](../src/dcl/content/types.ts).
