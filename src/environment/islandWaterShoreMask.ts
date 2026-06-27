import * as THREE from 'three'
import type { IslandShoreLayout } from '../dcl/landscape/islandLandscapeKeys'
import { ISLAND_BEACH_HEIGHT_GLSL } from './fftOcean/islandBeachHeight.glsl'

/** Terrain-height shore mask injected into three.js `Water.js` island plane. */
export function patchIslandTerrainShoreMask(
  material: THREE.ShaderMaterial,
  layout: IslandShoreLayout,
  centerXZ: THREE.Vector2
): void {
  const prev = material.onBeforeCompile
  material.onBeforeCompile = (shader, renderer) => {
    prev?.call(material, shader, renderer)
    shader.uniforms.uIslandCenterXZ = { value: centerXZ.clone() }
    shader.uniforms.uFlatRadiusM = { value: layout.flatRadiusM }
    shader.uniforms.uOuterRadiusM = { value: layout.outerRadiusM }

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>
uniform vec2 uIslandCenterXZ;
uniform float uFlatRadiusM;
uniform float uOuterRadiusM;
${ISLAND_BEACH_HEIGHT_GLSL}`
    )

    shader.fragmentShader = shader.fragmentShader.replace(
      'gl_FragColor = vec4( outgoingLight, alpha );',
      `float terrainY = islandBeachHeightAt(worldPosition.xz, uIslandCenterXZ, uFlatRadiusM, uOuterRadiusM);
float waterSurfaceY = worldPosition.y;
float landLift = terrainY - waterSurfaceY;
if (landLift > 0.45) discard;
float edgeAlpha = 1.0 - smoothstep(-0.15, 0.35, landLift);
float shoreMeet = 1.0 - smoothstep(0.0, 1.4, abs(terrainY - waterSurfaceY));
vec3 outColor = mix(outgoingLight, vec3(0.95, 0.97, 0.96), shoreMeet * 0.45);
gl_FragColor = vec4(outColor, alpha * edgeAlpha);`
    )
  }
  material.customProgramCacheKey = () =>
    `island-water-terrain:${layout.flatRadiusM.toFixed(1)}:${layout.outerRadiusM.toFixed(1)}`
}