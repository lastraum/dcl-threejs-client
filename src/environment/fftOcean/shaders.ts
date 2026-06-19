import { COMPLEX_GLSL, FRESNEL_GLSL, RANDOM_GLSL } from './glslIncludes'
import { ISLAND_BEACH_HEIGHT_GLSL } from './islandBeachHeight.glsl'
import { ISLAND_BEACH_HEIGHT_CONSTANTS } from '../../dcl/landscape/islandBeachHeight'

const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`

const FULLSCREEN_VERT_GLSL3 = /* glsl */ `
out vec2 vUv;
void main() {
    vUv = uv;
    gl_Position = vec4(position, 1.0);
}
`

export const INITIAL_SPECTRUM_FRAG = /* glsl */ `
uniform float uResolution;
uniform float uPatchSize;
uniform float uAmplitude;
uniform float uWindSpeed;
uniform vec2 uWindDirection;

precision highp float;

varying vec2 vUv;

${COMPLEX_GLSL}
${RANDOM_GLSL}

float calculatePhillips(vec2 k, float windSpeed, vec2 windDir, float amplitude, float kMagnitude) {
    kMagnitude = max(1e-6, kMagnitude);
    float L = (windSpeed * windSpeed) / 9.81;
    vec2 kHat = k / kMagnitude;
    float kDotW = max(0.0, dot(kHat, windDir));
    float kMagnitude2 = kMagnitude * kMagnitude;
    float kMagnitude4 = kMagnitude2 * kMagnitude2;
    float damping = exp(-1.0 / (kMagnitude2 * L * L));
    float phillipsEnergy = amplitude * (damping / kMagnitude4) * (kDotW * kDotW);
    return phillipsEnergy;
}

void main() {
    vec2 pixelCoord = floor(vUv * uResolution);
    float halfResolution = uResolution / 2.0;
    float nx = pixelCoord.x < halfResolution ? pixelCoord.x : pixelCoord.x - uResolution;
    float ny = pixelCoord.y < halfResolution ? pixelCoord.y : pixelCoord.y - uResolution;
    vec2 nVector = vec2(nx, ny);
    float dk = (2.0 * 3.14159265359) / uPatchSize;
    vec2 kVector = nVector * dk;
    float kMagnitude = length(kVector);
    float omega = sqrt(9.81 * kMagnitude);
    float phillipsEnergy = calculatePhillips(kVector, uWindSpeed, uWindDirection, uAmplitude, kMagnitude);

    vec2 h0 = vec2(0.0);
    if (phillipsEnergy > 0.0) {
        vec2 gauss = gaussianRandom(vUv);
        float energySqrt = sqrt(phillipsEnergy * dk * dk);
        float highFreqFilter = exp(-kMagnitude * kMagnitude * 0.1);
        float constant = energySqrt * 0.70710678 * highFreqFilter;
        h0 = vec2(gauss.x * constant, gauss.y * constant);
    }

    gl_FragColor = vec4(h0.x, h0.y, omega, 1.0);
}
`

export const TIME_EVOLUTION_FRAG = /* glsl */ `
uniform sampler2D uH0Target;
uniform float uResolution;
uniform float uTime;
uniform float uPatchSize;

precision highp float;

in vec2 vUv;

layout(location = 0) out vec4 outHeightJacobian;
layout(location = 1) out vec4 outAxisX;
layout(location = 2) out vec4 outAxisZ;

${COMPLEX_GLSL}

void main() {
    vec2 h0 = texture(uH0Target, vUv).rg;
    vec2 negUv = mod(1.0 - vUv + (1.0 / uResolution), 1.0);
    vec2 h0_minus_k = texture(uH0Target, negUv).rg;
    vec2 h0_minus_k_conj = vec2(h0_minus_k.x, -h0_minus_k.y);

    float omega = texture(uH0Target, vUv).b;
    float phase = omega * uTime;

    vec2 eulerRotation = complexExp(phase);
    vec2 eulerRotationNeg = complexExp(-phase);

    vec2 h0_t_pos = complexMultiply(h0, eulerRotation);
    vec2 h0_t_neg = complexMultiply(h0_minus_k_conj, eulerRotationNeg);
    vec2 finalHeight = h0_t_pos + h0_t_neg;

    vec2 pixelCoord = floor(vUv * uResolution);
    float nx = pixelCoord.x < (uResolution / 2.0) ? pixelCoord.x : pixelCoord.x - uResolution;
    float ny = pixelCoord.y < (uResolution / 2.0) ? pixelCoord.y : pixelCoord.y - uResolution;
    vec2 k = vec2(nx, ny) * (2.0 * 3.14159265 / uPatchSize);

    float kLength = length(k);
    vec2 kNormal = vec2(0.0);
    if (kLength > 0.00001) {
        kNormal = k / kLength;
    }

    vec2 h_choppy = vec2(finalHeight.y, -finalHeight.x);
    vec2 choppyX = h_choppy * kNormal.x;
    vec2 choppyZ = h_choppy * kNormal.y;
    vec2 slopeX = vec2(-finalHeight.y * k.x, finalHeight.x * k.x);
    vec2 slopeZ = vec2(-finalHeight.y * k.y, finalHeight.x * k.y);
    vec2 jacobian = finalHeight * kLength;

    outHeightJacobian = vec4(finalHeight, jacobian);
    outAxisX = vec4(choppyX, slopeX);
    outAxisZ = vec4(choppyZ, slopeZ);
}
`

export const BUTTERFLY_FRAG = /* glsl */ `
uniform float uStage;
uniform float uStages;
uniform int uDirection;
uniform sampler2D uButterflyTexture;
uniform sampler2D uPingPongTextureY;
uniform sampler2D uPingPongTextureX;
uniform sampler2D uPingPongTextureZ;

precision highp float;

in vec2 vUv;

layout(location = 0) out vec4 outHeightJacobian;
layout(location = 1) out vec4 outAxisX;
layout(location = 2) out vec4 outAxisZ;

${COMPLEX_GLSL}

void main() {
    float pixelIndex = (uDirection == 0) ? vUv.x : vUv.y;
    float stageUv = (uStage + 0.5) / uStages;
    vec4 instructions = texture(uButterflyTexture, vec2(stageUv, pixelIndex));

    float uEven = instructions.r;
    float uOdd = instructions.g;
    vec2 twiddle = instructions.ba;

    vec2 evenUv, oddUv;
    if (uDirection == 0) {
        evenUv = vec2(uEven, vUv.y);
        oddUv = vec2(uOdd, vUv.y);
    } else {
        evenUv = vec2(vUv.x, uEven);
        oddUv = vec2(vUv.x, uOdd);
    }

    vec4 evenData_Y = texture(uPingPongTextureY, evenUv);
    vec4 oddData_Y = texture(uPingPongTextureY, oddUv);
    vec2 evenComplex_Y = evenData_Y.rg;
    vec2 oddComplex_Y = oddData_Y.rg;
    vec2 evenJacobian = evenData_Y.ba;
    vec2 oddJacobian = oddData_Y.ba;

    vec4 evenData_X = texture(uPingPongTextureX, evenUv);
    vec4 oddData_X = texture(uPingPongTextureX, oddUv);
    vec2 evenChoppy_X = evenData_X.rg;
    vec2 oddChoppy_X = oddData_X.rg;
    vec2 evenSlope_X = evenData_X.ba;
    vec2 oddSlope_X = oddData_X.ba;

    vec4 evenData_Z = texture(uPingPongTextureZ, evenUv);
    vec4 oddData_Z = texture(uPingPongTextureZ, oddUv);
    vec2 evenChoppy_Z = evenData_Z.rg;
    vec2 oddChoppy_Z = oddData_Z.rg;
    vec2 evenSlope_Z = evenData_Z.ba;
    vec2 oddSlope_Z = oddData_Z.ba;

    vec2 rotatedOdd_Y = complexMultiply(twiddle, oddComplex_Y);
    vec2 rotatedOddJacobian = complexMultiply(twiddle, oddJacobian);
    vec2 rotatedOddChoppy_X = complexMultiply(twiddle, oddChoppy_X);
    vec2 rotatedOddSlope_X = complexMultiply(twiddle, oddSlope_X);
    vec2 rotatedOddChoppy_Z = complexMultiply(twiddle, oddChoppy_Z);
    vec2 rotatedOddSlope_Z = complexMultiply(twiddle, oddSlope_Z);

    vec2 result_Y = evenComplex_Y + rotatedOdd_Y;
    vec2 resultJacobian = evenJacobian + rotatedOddJacobian;
    vec2 resultChoppy_X = evenChoppy_X + rotatedOddChoppy_X;
    vec2 resultSlope_X = evenSlope_X + rotatedOddSlope_X;
    vec2 resultChoppy_Z = evenChoppy_Z + rotatedOddChoppy_Z;
    vec2 resultSlope_Z = evenSlope_Z + rotatedOddSlope_Z;

    outHeightJacobian = vec4(result_Y, resultJacobian);
    outAxisX = vec4(resultChoppy_X, resultSlope_X);
    outAxisZ = vec4(resultChoppy_Z, resultSlope_Z);
}
`

export const OCEAN_VERT = /* glsl */ `
uniform sampler2D uDisplacementY;
uniform sampler2D uDisplacementX;
uniform sampler2D uDisplacementZ;
uniform float uScale;
uniform float uPatchSize;
uniform vec2 uViewerPos;
uniform float uResolution;
uniform float uBaseVertexSpacing;
uniform float uNormalScale;
uniform float uChoppyScale;

uniform bool uIslandMask;
uniform vec2 uIslandCenterXZ;
uniform float uFlatRadiusM;
uniform float uOuterRadiusM;
uniform vec2 uSnapXZ;
uniform vec2 uGroupWorldXZ;
uniform float uWaterWorldY;
uniform float uShoreDampWidthM;

${ISLAND_BEACH_HEIGHT_GLSL}

out vec2 vUv;
out vec3 vWorldPosition;
out vec3 vViewDirection;
out float vHeight;
out vec3 vNormal;
out float vJacobian;
out float vTerrainY;

void main() {
    float localDist = max(abs(position.x), abs(position.z));
    float lod0Radius = (uResolution / 2.0) * uBaseVertexSpacing;
    float lod = max(0.0, ceil(log2(localDist / lod0Radius) - 0.001));

    float gridSize = uBaseVertexSpacing * exp2(lod);
    float nextGridSize = gridSize * 2.0;

    vec2 snappedCamera = floor(uViewerPos / gridSize) * gridSize;
    vec2 worldXZ = position.xz + snappedCamera;

    vec2 worldXZ_next = floor((worldXZ + 0.001) / nextGridSize) * nextGridSize;
    float currentRadius = lod0Radius * exp2(lod);
    float morphStart = currentRadius - 2.0 * gridSize;
    float morphAlpha = clamp((localDist - morphStart) / (2.0 * gridSize), 0.0, 1.0);
    vec2 finalWorldXZ = mix(worldXZ, worldXZ_next, morphAlpha);

    vec2 fftUv = finalWorldXZ / uPatchSize;

    float height = texture(uDisplacementY, fftUv).r;
    vec4 dataX = texture(uDisplacementX, fftUv);
    vec4 dataZ = texture(uDisplacementZ, fftUv);

    float choppyX = dataX.x;
    float choppyZ = dataZ.x;

    float dampen = 1.0;
    vec2 globalXZ = finalWorldXZ - snappedCamera + uGroupWorldXZ;
    float terrainY = ISLAND_WATER_LEVEL_Y - ISLAND_OFFSHORE_DEPTH_M;
    if (uIslandMask) {
        terrainY = islandBeachHeightAt(globalXZ, uIslandCenterXZ, uFlatRadiusM, uOuterRadiusM);
        dampen = islandShoreWaveDampen(terrainY, uShoreDampWidthM);
    }

    height *= dampen;
    choppyX *= dampen;
    choppyZ *= dampen;

    vec3 worldPos = vec3(
        globalXZ.x - choppyX * uScale * uChoppyScale,
        uWaterWorldY + height * uScale,
        globalXZ.y - choppyZ * uScale * uChoppyScale
    );

    float slopeX = dataX.z * dampen;
    float slopeZ = dataZ.z * dampen;
    float actualSlopeX = slopeX * uScale * uNormalScale;
    float actualSlopeZ = slopeZ * uScale * uNormalScale;
    vec3 worldNormal = normalize(vec3(-actualSlopeX, 1.0, -actualSlopeZ));

    gl_Position = projectionMatrix * viewMatrix * vec4(worldPos, 1.0);

    vUv = fftUv;
    vWorldPosition = worldPos;
    vViewDirection = normalize(cameraPosition - vWorldPosition);
    vHeight = height * uScale;
    vNormal = normalize(worldNormal);
    vJacobian = texture(uDisplacementY, fftUv).b * dampen;
    vTerrainY = terrainY;
}
`

export const OCEAN_FRAG = /* glsl */ `
uniform float uTime;
uniform sampler2D uDisplacementY;
uniform sampler2D uDisplacementX;
uniform sampler2D uDisplacementZ;
uniform float uScale;

uniform vec3 uWaterDeep;
uniform vec3 uWaterShallow;
uniform float uColorMinHeight;
uniform float uColorMaxHeight;

uniform vec3 uSunPosition;
uniform vec3 uSunColor;
uniform float uSpecularPower;
uniform float uSpecularMin;
uniform float uSpecularMax;
uniform float uSpecularIntensity;

uniform bool uUseEnvMap;
uniform samplerCube uEnvMap;
uniform vec3 uSkyHorizon;
uniform vec3 uSkyZenith;

uniform vec3 uWaterSSS;
uniform float uSssPower;
uniform float uSssScale;
uniform float uSssMinHeight;
uniform float uSssMaxHeight;
uniform float uSssWrap;

uniform vec3 uFoamColor;
uniform sampler2D uFoamTexture;
uniform float uFoamThreshold;
uniform float uFoamScale;
uniform vec2 uFoamSpeed;
uniform float uFoamDistortion;
uniform float uFoamEdgeSoftness;
uniform float uFoamPower;
uniform float uFresnelSmoothness;

uniform bool uIslandMask;
uniform vec2 uIslandCenterXZ;
uniform float uFlatRadiusM;
uniform float uOuterRadiusM;
uniform vec2 uSnapXZ;
uniform vec2 uGroupWorldXZ;

in vec2 vUv;
in vec3 vWorldPosition;
in vec3 vViewDirection;
in float vHeight;
in vec3 vNormal;
in float vJacobian;
in float vTerrainY;

out vec4 fragColor;

const float ISLAND_WATER_LEVEL_Y = ${ISLAND_BEACH_HEIGHT_CONSTANTS.waterLevelY.toFixed(1)};

${FRESNEL_GLSL}

void main() {
    vec3 normal = normalize(vNormal);
    vec3 viewDirection = normalize(vViewDirection);
    vec3 lightDirection = normalize(uSunPosition);

    float heightMask = smoothstep(uColorMinHeight, uColorMaxHeight, vHeight);
    vec3 baseWaterColor = mix(uWaterDeep, uWaterShallow, heightMask);

    float sssAlignment = max(0.0, dot(viewDirection, -lightDirection));
    float sssTerm = pow(sssAlignment, uSssPower) * uSssScale;
    float sssMask = smoothstep(uSssMinHeight, uSssMaxHeight, vHeight);
    float sssLightEmmission = max(0.0, dot(normal, -lightDirection) + uSssWrap);
    sssMask *= sssLightEmmission;
    vec3 sssColor = uWaterSSS * sssTerm * sssMask;
    vec3 waterInside = baseWaterColor + sssColor;

    vec3 upVector = vec3(0.0, 1.0, 0.0);
    vec3 fresnelNormal = normalize(mix(normal, upVector, uFresnelSmoothness));
    vec3 reflectionVector = reflect(-viewDirection, fresnelNormal);
    vec3 envReflection = uUseEnvMap
        ? textureLod(uEnvMap, reflectionVector, 1.5).rgb
        : mix(uSkyHorizon, uSkyZenith, smoothstep(-0.15, 0.85, reflectionVector.y));

    float fresnelFactor = calculateFresnel(viewDirection, fresnelNormal, 0.02, 1.0);

    vec3 halfVector = normalize(lightDirection + viewDirection);
    float specularTerm = pow(max(dot(halfVector, normal), 0.0), uSpecularPower);
    float sunPathMask = smoothstep(uSpecularMin, uSpecularMax, specularTerm);
    vec3 directSpecular = uSunColor * sunPathMask * uSpecularIntensity;
    vec3 surfaceReflection = envReflection + directSpecular;

    vec3 finalColor = mix(waterInside, surfaceReflection, fresnelFactor);
    finalColor = clamp(finalColor, 0.0, 1.0);

    vec2 foamUv1 = vUv * uFoamScale;
    foamUv1 += uTime * (uFoamSpeed * 0.05);
    vec2 foamUv2 = vUv * (uFoamScale * 1.2);
    foamUv2 += uTime * (-uFoamSpeed * 0.07);
    float foamNoise1 = texture(uFoamTexture, foamUv1).r;
    float foamNoise2 = texture(uFoamTexture, foamUv2).r;
    float foamNoise = foamNoise1 * foamNoise2;

    float turbulence = max(0.0, vJacobian);
    turbulence *= uScale * uFoamPower * 10.0;
    float jacobianCoverage = smoothstep(uFoamThreshold, uFoamThreshold + uFoamEdgeSoftness, turbulence);
    float foamMask = jacobianCoverage * pow(foamNoise, 1.0 / uFoamDistortion);
    foamMask = clamp(foamMask, 0.0, 1.0);

    finalColor = mix(finalColor, uFoamColor, foamMask);

    float alpha = 1.0;
    if (uIslandMask) {
        float waterSurfaceY = vWorldPosition.y;
        float landLift = vTerrainY - waterSurfaceY;
        if (landLift > 0.25) discard;

        alpha = 1.0 - smoothstep(-0.1, 0.2, landLift);

        float shoreMeet = 1.0 - smoothstep(0.0, 1.4, abs(vTerrainY - waterSurfaceY));
        float foamBand = shoreMeet * (0.55 + 0.45 * foamMask);
        finalColor = mix(finalColor, vec3(0.95, 0.97, 0.96), foamBand * 0.5);
    }

    fragColor = vec4(finalColor, alpha);
}
`

export const GPGPU_VERT = FULLSCREEN_VERT
export const GPGPU_VERT_GLSL3 = FULLSCREEN_VERT_GLSL3