import * as THREE from 'three'
import type { IslandShoreLayout } from '../dcl/landscape/islandLandscapeKeys'
import type { AuthorTerrainHeightMap } from './authorTerrainHeightMap'
import {
  AUTHOR_TERRAIN_HEIGHT_GLSL1,
  ISLAND_BEACH_HEIGHT_GLSL
} from './fftOcean/islandBeachHeight.glsl'

/** 1×1 float placeholder so uAuthorHeightMap is always bound on Water.js path. */
function makeDummyHeightTexture(): THREE.DataTexture {
  const data = new Float32Array([0, 0, 0, 1])
  const tex = new THREE.DataTexture(data, 1, 1, THREE.RGBAFormat, THREE.FloatType)
  tex.needsUpdate = true
  return tex
}

/** Terrain-height shore mask injected into three.js `Water.js` island plane. */
export function patchIslandTerrainShoreMask(
  material: THREE.ShaderMaterial,
  layout: IslandShoreLayout,
  centerXZ: THREE.Vector2,
  authorHeightMap?: AuthorTerrainHeightMap | null
): void {
  const author = authorHeightMap ?? null
  const dummy = author ? null : makeDummyHeightTexture()
  // Stash dummy so dispose can free it if we own it.
  if (dummy) {
    material.userData.authorHeightDummy = dummy
  }

  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer)
    shader.uniforms.uIslandCenterXZ = { value: centerXZ.clone() }
    shader.uniforms.uFlatRadiusM = { value: layout.flatRadiusM }
    shader.uniforms.uOuterRadiusM = { value: layout.outerRadiusM }
    shader.uniforms.uAuthorHeightEnabled = { value: author != null }
    shader.uniforms.uAuthorHeightMap = {
      value: author?.texture ?? dummy
    }
    shader.uniforms.uAuthorOriginDclXZ = {
      value: new THREE.Vector2(author?.originX ?? 0, author?.originZ ?? 0)
    }
    shader.uniforms.uAuthorSizeM = {
      value: new THREE.Vector2(author?.widthM ?? 1, author?.depthM ?? 1)
    }

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform vec2 uIslandCenterXZ;
uniform float uFlatRadiusM;
uniform float uOuterRadiusM;
uniform bool uAuthorHeightEnabled;
uniform sampler2D uAuthorHeightMap;
uniform vec2 uAuthorOriginDclXZ;
uniform vec2 uAuthorSizeM;
${ISLAND_BEACH_HEIGHT_GLSL}
${AUTHOR_TERRAIN_HEIGHT_GLSL1}`
    )

    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( outgoingLight, alpha );',
      `// Mean sea level = flat Water.js plane Y.
float waterY = worldPosition.y;
float dist = length(worldPosition.xz - uIslandCenterXZ);
// Land disc (parcel centre → corner): hard cutout so ocean never floods the island.
float landDisc = 1.0 - smoothstep(uFlatRadiusM - 0.35, uFlatRadiusM + 0.15, dist);
if (landDisc > 0.5) discard;

float terrainY = islandBeachHeightAtWater(
  worldPosition.xz, uIslandCenterXZ, uFlatRadiusM, uOuterRadiusM, waterY
);
if (uAuthorHeightEnabled) {
  float authorY = authorTerrainHeightAt(
    worldPosition.xz, uAuthorHeightMap, uAuthorOriginDclXZ, uAuthorSizeM, waterY
  );
  terrainY = max(terrainY, authorY);
}
float landLift = terrainY - waterY;
if (landLift > 0.55) discard;
float edgeAlpha = 1.0 - smoothstep(0.12, 0.55, landLift);
float shoreMeet = 1.0 - smoothstep(0.0, 1.6, abs(landLift));
float rim = 1.0 - smoothstep(0.0, 1.8, abs(dist - uFlatRadiusM));
shoreMeet = max(shoreMeet, rim);
vec3 outColor = mix(outgoingLight, vec3(0.95, 0.97, 0.96), shoreMeet * 0.45);
gl_FragColor = vec4(outColor, alpha * edgeAlpha);`
    )
  }
  const authorKey = author
    ? `a${author.resolution}:${author.widthM.toFixed(0)}x${author.depthM.toFixed(0)}`
    : 'a0'
  material.customProgramCacheKey = () =>
    `island-water-terrain:${layout.flatRadiusM.toFixed(1)}:${layout.outerRadiusM.toFixed(1)}:${authorKey}`
}
