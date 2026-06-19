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

float islandBeachHeightAt(
    vec2 globalThreeXZ,
    vec2 islandCenterXZ,
    float flatRadiusM,
    float outerRadiusM
) {
    float distM = length(globalThreeXZ - islandCenterXZ);
    if (distM > outerRadiusM + 2.0) {
        return ISLAND_WATER_LEVEL_Y - ISLAND_OFFSHORE_DEPTH_M;
    }

    if (distM <= flatRadiusM) {
        return ISLAND_TERRAIN_BASE_Y;
    }

    float blendIn = smoothstep(flatRadiusM, flatRadiusM + ISLAND_HEIGHTMAP_BLEND_M, distM);
    float beachT = smoothstep(flatRadiusM, outerRadiusM, distM);
    float shoreY = ISLAND_WATER_LEVEL_Y + ISLAND_SHORE_Y_OFFSET;
    float radialBase = mix(ISLAND_TERRAIN_BASE_Y, shoreY, beachT * beachT * (3.0 - 2.0 * beachT));

    float dclX = -globalThreeXZ.x;
    float dclZ = globalThreeXZ.y;
    vec2 dunesP = vec2(dclX, dclZ) * 0.07;
    float dunes = (islandBeachFbm01(dunesP, ISLAND_HEIGHT_SEED) - 0.5) * ISLAND_DUNE_AMP_M;
    float edgeDrop = beachT * ISLAND_BEACH_MAX_DROP_M * 0.12;

    return radialBase + (dunes - edgeDrop) * blendIn;
}

float islandShoreWaveDampen(float terrainY, float shoreDampWidthM) {
    float landLift = terrainY - ISLAND_WATER_LEVEL_Y;
    return 1.0 - smoothstep(-shoreDampWidthM * 0.15, shoreDampWidthM * 0.2, landLift);
}
`