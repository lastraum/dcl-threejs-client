import * as THREE from 'three'

/**
 * ez-tree grass wind vertex path — shared by outdoor EzTreeGrassField and editor paint.
 * Uniform lifetime matches foliageWind (stable uTime ref + onBeforeCompile + needsUpdate).
 * @see https://github.com/dgreenheck/ez-tree/blob/main/src/app/grass.js
 */

export const GRASS_WIND = {
  strength: new THREE.Vector3(0.3, 0, 0.3),
  frequency: 1.0,
  scale: 400.0
} as const

const SIMPLEX_GLSL = `
        vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
        vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }
        float simplex2d(vec2 v) {
          const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
          vec2 i = floor(v + dot(v, C.yy));
          vec2 x0 = v - i + dot(i, C.xx);
          vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
          vec4 x12 = x0.xyxy + C.xxzz;
          x12.xy -= i1;
          i = mod289(i);
          vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
          vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
          m = m * m; m = m * m;
          vec3 x = 2.0 * fract(p * C.www) - 1.0;
          vec3 h = abs(x) - 0.5;
          vec3 ox = floor(x + 0.5);
          vec3 a0 = x - ox;
          m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
          vec3 g;
          g.x = a0.x * x0.x + h.x * x0.y;
          g.yz = a0.yz * x12.xz + h.yz * x12.yw;
          return 130.0 * dot(m, g);
        }
`

/** Inject wind vertex sway into a grass material. Safe to call once per material. */
export function appendGrassWindShader(
  material: THREE.MeshPhongMaterial | THREE.MeshStandardMaterial,
  instanced: boolean
): void {
  if (material.userData.grassWindPatched === true) return

  const uTime = { value: 0 }
  material.userData.grassWindTime = uTime
  material.userData.grassWindPatched = true
  material.userData.grassWindInstanced = instanced
  material.customProgramCacheKey = () =>
    `ez-tree-grass-wind:${instanced ? 'i' : 's'}:${material.uuid}`

  // Ensure time is live even before the first compile / between programs.
  material.onBeforeRender = () => {
    // value is driven by setGrassWindElapsed / field update
  }

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = uTime
    shader.uniforms.uWindStrength = { value: GRASS_WIND.strength }
    shader.uniforms.uWindFrequency = { value: GRASS_WIND.frequency }
    shader.uniforms.uWindScale = { value: GRASS_WIND.scale }

    shader.vertexShader =
      `
      uniform float uTime;
      uniform vec3 uWindStrength;
      uniform float uWindFrequency;
      uniform float uWindScale;
      ` + shader.vertexShader

    if (!shader.vertexShader.includes('float simplex2d(vec2 v)')) {
      shader.vertexShader = shader.vertexShader.replace(
        `void main() {`,
        `${SIMPLEX_GLSL}
        void main() {`
      )
    }

    if (!shader.vertexShader.includes('#include <project_vertex>')) {
      console.warn('[grassWind] project_vertex include missing — wind not applied', material.name)
      return
    }

    const projectVertex = instanced
      ? `
        vec4 mvPosition = instanceMatrix * vec4(transformed, 1.0);
        float windOffset = 6.28318 * simplex2d((modelMatrix * mvPosition).xz / uWindScale);
        vec3 windSway = position.y * uWindStrength *
          sin(uTime * uWindFrequency + windOffset) *
          cos(uTime * 1.4 * uWindFrequency + windOffset);
        mvPosition.xyz += windSway;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `
      : `
        vec4 mvPosition = vec4(transformed, 1.0);
        float windOffset = 6.28318 * simplex2d((modelMatrix * mvPosition).xz / uWindScale);
        vec3 windSway = 0.2 * position.y * uWindStrength *
          sin(uTime * uWindFrequency + windOffset) *
          cos(uTime * 1.4 * uWindFrequency + windOffset);
        mvPosition.xyz += windSway;
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;
      `

    shader.vertexShader = shader.vertexShader.replace(/#include <project_vertex>/, projectVertex)
    material.userData.shader = shader
  }

  material.needsUpdate = true
}

/** Drive grass wind time (call every frame when wind is enabled). */
export function setGrassWindElapsed(
  material: THREE.Material | null | undefined,
  elapsed: number
): void {
  if (!material) return
  const uTime = material.userData.grassWindTime as { value: number } | undefined
  if (uTime) uTime.value = elapsed
  const shader = material.userData.shader as
    | { uniforms: { uTime?: { value: number } } }
    | undefined
  if (shader?.uniforms?.uTime) shader.uniforms.uTime.value = elapsed
}
