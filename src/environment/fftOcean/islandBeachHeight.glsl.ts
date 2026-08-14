import { ISLAND_BEACH_HEIGHT_CONSTANTS as C } from '../../dcl/landscape/islandBeachHeight'

/** GLSL float literal — bare integers fail `const float` assignment on some drivers. */
function glslFloat(n: number): string {
  return Number.isInteger(n) ? `${n}.0` : String(n)
}

/**
 * GPU mirror of `islandBeachHeight.ts` — keep constants and logic in sync.
 * `globalThreeXZ` is world-space XZ (same as shore mesh vertices).
 */
export const ISLAND_BEACH_HEIGHT_GLSL = /* glsl */ `
const float ISLAND_TERRAIN_BASE_Y = ${glslFloat(C.terrainBaseY)};
const float ISLAND_WATER_LEVEL_Y = ${glslFloat(C.waterLevelY)};
const float ISLAND_HEIGHTMAP_BLEND_M = ${glslFloat(C.heightmapBlendM)};
const float ISLAND_BEACH_MAX_DROP_M = ${glslFloat(C.beachMaxDropM)};
const float ISLAND_DUNE_AMP_M = ${glslFloat(C.duneAmpM)};
const int ISLAND_HEIGHT_SEED = ${C.heightSeed};
const float ISLAND_SHORE_Y_OFFSET = ${glslFloat(C.shoreYOffset)};
const float ISLAND_OFFSHORE_DEPTH_M = ${glslFloat(C.offshoreDepthM)};

uint islandBeachHash2(ivec2 p, int seed) {
    uint h = uint(p.x) * 374761393u + uint(p.y) * 668265263u + uint(seed) * 982451653u;
    h = (h ^ (h >> 16u)) * 0x7feb352du;
    h = (h ^ (h >> 15u)) * 0x846ca68bu;
    return h ^ (h >> 16u);
}

float islandBeachFade(float t) {
    return t * t * t * (t * (t * 6.0 - 15.0) + 10.0);
}

float islandBeachGrad2(uint h, vec2 d) {
    int idx = int(h & 7u);
    vec2 g;
    if (idx == 0) g = vec2(1.0, 1.0);
    else if (idx == 1) g = vec2(-1.0, 1.0);
    else if (idx == 2) g = vec2(1.0, -1.0);
    else if (idx == 3) g = vec2(-1.0, -1.0);
    else if (idx == 4) g = vec2(1.0, 0.0);
    else if (idx == 5) g = vec2(-1.0, 0.0);
    else if (idx == 6) g = vec2(0.0, 1.0);
    else g = vec2(0.0, -1.0);
    return dot(g, d);
}

float islandBeachPerlin01(vec2 p, int seed) {
    ivec2 i = ivec2(floor(p));
    vec2 f = fract(p);
    float u = islandBeachFade(f.x);
    float v = islandBeachFade(f.y);

    float n00 = islandBeachGrad2(islandBeachHash2(i, seed) & 255u, f);
    float n10 = islandBeachGrad2(islandBeachHash2(i + ivec2(1, 0), seed) & 255u, f - vec2(1.0, 0.0));
    float n01 = islandBeachGrad2(islandBeachHash2(i + ivec2(0, 1), seed) & 255u, f - vec2(0.0, 1.0));
    float n11 = islandBeachGrad2(islandBeachHash2(i + ivec2(1, 1), seed) & 255u, f - vec2(1.0, 1.0));

    float nx0 = mix(n00, n10, u);
    float nx1 = mix(n01, n11, u);
    return mix(nx0, nx1, v) * 0.5 + 0.5;
}

float islandBeachFbm01(vec2 p, int seed) {
    float v = 0.0;
    float amp = 0.5;
    float freq = 1.0;
    for (int i = 0; i < 4; i++) {
        v += amp * islandBeachPerlin01(p * freq, seed + i * 17);
        freq *= 2.03;
        amp *= 0.5;
    }
    return v;
}

/**
 * Procedural island beach height. When waterY is provided (FFT ocean), shore slopes
 * to that mean sea level so editor Water To / play surface stay aligned.
 * Legacy 4-arg form uses baked ISLAND_WATER_LEVEL_Y (Water.js / shore mesh).
 */
float islandBeachHeightAtWater(
    vec2 globalThreeXZ,
    vec2 islandCenterXZ,
    float flatRadiusM,
    float outerRadiusM,
    float waterY
) {
    float distM = length(globalThreeXZ - islandCenterXZ);
    if (distM > outerRadiusM + 2.0) {
        return waterY - ISLAND_OFFSHORE_DEPTH_M;
    }

    if (distM <= flatRadiusM) {
        return ISLAND_TERRAIN_BASE_Y;
    }

    float blendIn = smoothstep(flatRadiusM, flatRadiusM + ISLAND_HEIGHTMAP_BLEND_M, distM);
    float beachT = smoothstep(flatRadiusM, outerRadiusM, distM);
    float shoreY = waterY + ISLAND_SHORE_Y_OFFSET;
    float radialBase = mix(ISLAND_TERRAIN_BASE_Y, shoreY, beachT * beachT * (3.0 - 2.0 * beachT));

    float dclX = -globalThreeXZ.x;
    float dclZ = globalThreeXZ.y;
    vec2 dunesP = vec2(dclX, dclZ) * 0.07;
    float dunes = (islandBeachFbm01(dunesP, ISLAND_HEIGHT_SEED) - 0.5) * ISLAND_DUNE_AMP_M;
    float edgeDrop = beachT * ISLAND_BEACH_MAX_DROP_M * 0.12;

    return radialBase + (dunes - edgeDrop) * blendIn;
}

float islandBeachHeightAt(
    vec2 globalThreeXZ,
    vec2 islandCenterXZ,
    float flatRadiusM,
    float outerRadiusM
) {
    return islandBeachHeightAtWater(
        globalThreeXZ, islandCenterXZ, flatRadiusM, outerRadiusM, ISLAND_WATER_LEVEL_Y
    );
}

float islandShoreWaveDampen(float terrainY, float shoreDampWidthM) {
    float landLift = terrainY - ISLAND_WATER_LEVEL_Y;
    return 1.0 - smoothstep(-shoreDampWidthM * 0.15, shoreDampWidthM * 0.2, landLift);
}

/**
 * Wave damp near shore. Slightly wider underwater ramp so waves ease in before
 * the cutout, instead of hard-zeroing and looking like the surface bottomed out.
 */
float shoreWaveDampenAt(float terrainY, float waterY, float shoreDampWidthM) {
    float landLift = terrainY - waterY;
    float w = max(0.5, shoreDampWidthM);
    // Full waves well below MSL; ramp off through the wet zone; zero on land.
    return 1.0 - smoothstep(-w * 0.55, w * 0.35, landLift);
}
`

/**
 * GLSL3 author height sample (`texture`). FFT ocean path only.
 * Water.js uses GLSL1 — see `islandWaterShoreMask` for `texture2D` twin.
 */
export const AUTHOR_TERRAIN_HEIGHT_GLSL3 = /* glsl */ `
float authorTerrainHeightAt(
    vec2 globalThreeXZ,
    sampler2D heightMap,
    vec2 originDclXZ,
    vec2 sizeM,
    float waterY
) {
    float dclX = -globalThreeXZ.x;
    float dclZ = globalThreeXZ.y;
    vec2 uv = (vec2(dclX, dclZ) - originDclXZ) / max(sizeM, vec2(1e-4));
    if (uv.x < -0.002 || uv.x > 1.002 || uv.y < -0.002 || uv.y > 1.002) {
        return waterY - ISLAND_OFFSHORE_DEPTH_M;
    }
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    return texture(heightMap, uv).r;
}
`

/** GLSL1 author height sample (`texture2D`) for three.js Water.js shore mask. */
export const AUTHOR_TERRAIN_HEIGHT_GLSL1 = /* glsl */ `
float authorTerrainHeightAt(
    vec2 globalThreeXZ,
    sampler2D heightMap,
    vec2 originDclXZ,
    vec2 sizeM,
    float waterY
) {
    float dclX = -globalThreeXZ.x;
    float dclZ = globalThreeXZ.y;
    vec2 uv = (vec2(dclX, dclZ) - originDclXZ) / max(sizeM, vec2(1e-4));
    if (uv.x < -0.002 || uv.x > 1.002 || uv.y < -0.002 || uv.y > 1.002) {
        return waterY - ISLAND_OFFSHORE_DEPTH_M;
    }
    uv = clamp(uv, vec2(0.0), vec2(1.0));
    return texture2D(heightMap, uv).r;
}
`