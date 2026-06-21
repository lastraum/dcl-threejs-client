import * as THREE from 'three'

type Color4 = { r?: number; g?: number; b?: number; a?: number }
type Color3 = { r?: number; g?: number; b?: number }

const DIRECT_INTENSITY_CACHE_KEY = 'dclDirectIntensityKey'

/** DCL HDR albedo — channel values above 1 contribute emissive glow. */
export function applyHdrAlbedoAndEmissive(
  material: THREE.MeshPhysicalMaterial,
  albedo: Color4,
  emissiveColor?: Color3,
  emissiveIntensity?: number
): void {
  const r = albedo.r ?? 1
  const g = albedo.g ?? 1
  const b = albedo.b ?? 1
  material.color.setRGB(Math.min(r, 1), Math.min(g, 1), Math.min(b, 1))

  const hdrR = Math.max(0, r - 1)
  const hdrG = Math.max(0, g - 1)
  const hdrB = Math.max(0, b - 1)
  const ec = emissiveColor ?? { r: 0, g: 0, b: 0 }

  material.emissive.setRGB((ec.r ?? 0) + hdrR, (ec.g ?? 0) + hdrG, (ec.b ?? 0) + hdrB)
  material.emissiveIntensity = emissiveIntensity ?? 1
}

export function applyPbrScalars(
  material: THREE.MeshPhysicalMaterial,
  pbr: {
    metallic?: number
    roughness?: number
    reflectivityColor?: Color3
    specularIntensity?: number
    directIntensity?: number
  }
): void {
  material.metalness = pbr.metallic ?? 0.5
  material.roughness = pbr.roughness ?? 0.5

  const spec = pbr.reflectivityColor ?? { r: 1, g: 1, b: 1 }
  material.specularColor.setRGB(spec.r ?? 1, spec.g ?? 1, spec.b ?? 1)
  material.specularIntensity = pbr.specularIntensity ?? 1

  applyDirectIntensity(material, pbr.directIntensity ?? 1)
}

function applyDirectIntensity(material: THREE.MeshPhysicalMaterial, intensity: number): void {
  const clamped = Math.max(0, intensity)
  const prevKey = material.userData[DIRECT_INTENSITY_CACHE_KEY] as string | undefined
  const nextKey = clamped === 1 ? '1' : `dcl-di-${clamped.toFixed(4)}`
  if (prevKey === nextKey) return
  material.userData[DIRECT_INTENSITY_CACHE_KEY] = nextKey

  if (clamped === 1) {
    material.onBeforeCompile = () => {}
    material.customProgramCacheKey = () => 'dcl-di-1'
    material.needsUpdate = true
    return
  }

  material.customProgramCacheKey = () => nextKey
  material.onBeforeCompile = (shader) => {
    shader.uniforms.dclDirectIntensity = { value: clamped }
    shader.fragmentShader = shader.fragmentShader.replace(
      'void main() {',
      'uniform float dclDirectIntensity;\nvoid main() {'
    )
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <lights_physical_fragment>',
      `#include <lights_physical_fragment>
      reflectedLight.directDiffuse *= dclDirectIntensity;
      reflectedLight.directSpecular *= dclDirectIntensity;`
    )
  }
  material.needsUpdate = true
}

