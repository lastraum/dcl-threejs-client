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

/**
 * Apply ECS PBR color scalars — only touches albedo tint when `albedoColor` is set.
 * Genesis firepit sets texture + emissiveTexture + emissiveColor, not albedoColor.
 */
export function applyPbrColors(
  material: THREE.MeshPhysicalMaterial,
  pbr: {
    albedoColor?: Color4
    emissiveColor?: Color3
    emissiveIntensity?: number
  }
): void {
  const ec = pbr.emissiveColor
  const er = ec?.r ?? 0
  const eg = ec?.g ?? 0
  const eb = ec?.b ?? 0
  const emissiveLum = (er + eg + eb) / 3
  const intensity = pbr.emissiveIntensity ?? 1

  if (pbr.albedoColor) {
    const ar = pbr.albedoColor.r ?? 1
    const ag = pbr.albedoColor.g ?? 1
    const ab = pbr.albedoColor.b ?? 1
    const albedoLum = (ar + ag + ab) / 3
    // Selection rings / click VFX: white albedo + colored emissive reads as washed white under
    // ACES if we keep full albedo. Drive the surface with emissive color (Explorer glow discs).
    if (albedoLum > 0.88 && emissiveLum > 0.12 && !material.map) {
      material.color.setRGB(Math.min(er, 1), Math.min(eg, 1), Math.min(eb, 1))
      material.emissive.setRGB(Math.min(er, 1), Math.min(eg, 1), Math.min(eb, 1))
      material.emissiveIntensity = Math.max(intensity, 1.35)
      material.metalness = 0
      material.roughness = 1
      material.toneMapped = false
      material.envMapIntensity = 0
      return
    }
    applyHdrAlbedoAndEmissive(material, pbr.albedoColor, pbr.emissiveColor, pbr.emissiveIntensity)
    return
  }

  if (ec) {
    material.emissive.setRGB(er, eg, eb)
  } else {
    material.emissive.setRGB(0, 0, 0)
  }
  material.emissiveIntensity = intensity
}

/**
 * High-intensity emissive sprites (firepit flames, neon cutouts): black albedo so only
 * emissiveMap × intensity lights the surface; map alpha drives ALPHA_BLEND cutouts.
 *
 * Only apply once emissiveMap is bound — black with no maps is an invisible plane
 * (sprite pool can re-touch scalars before textures land).
 *
 * Opaque floors/walls that stamp the same texture into albedo + emissiveTexture must
 * NOT take the sprite path — black albedo + toneMapped=false + bloom washes tiles white
 * (threejs.dcl.eth HexagonFloor / Creator Hub asset packs).
 */
export function configureEmissiveRendering(
  material: THREE.MeshPhysicalMaterial,
  emissiveIntensity?: number,
  hasEmissiveMap?: boolean,
  /** MTM_ALPHA_BLEND = 2 / MTM_ALPHA_TEST_AND_ALPHA_BLEND = 3 */
  transparencyMode?: number
): void {
  const intensity = emissiveIntensity ?? 1
  const alphaBlend = transparencyMode === 2 || transparencyMode === 3
  const sharedAlbedoEmissive = !!(
    hasEmissiveMap &&
    material.map &&
    material.emissiveMap &&
    material.map === material.emissiveMap
  )
  // Glow markers (narrow) — never promote ordinary floors/fog into this path:
  // 1) Map-less ALPHA_BLEND click rings (DecentraCraft Vf: alpha 0.75, emissive 1.6)
  // 2) Flame/LED sheets driven by emissiveMap (not opaque shared albedo+emissive bake)
  // Prior over-broad rule (any intensity≥1.5 + !map) washed textured ground during load.
  const emissiveLum =
    material.emissive.r + material.emissive.g + material.emissive.b
  const mapLessClickRing =
    alphaBlend &&
    !hasEmissiveMap &&
    !material.map &&
    intensity >= 1.5 &&
    emissiveLum > 0.05
  const flameOrLedSprite =
    !!hasEmissiveMap &&
    intensity >= 1.5 &&
    !sharedAlbedoEmissive &&
    (alphaBlend || material.transparent || !material.map)
  const glowSprite = mapLessClickRing || flameOrLedSprite

  if (glowSprite) {
    // Keep tinted albedo for solid-color rings (map-less); black only when emissiveMap drives.
    if (hasEmissiveMap) {
      material.color.setRGB(0, 0, 0)
    }
    material.metalness = 0
    material.roughness = 1
    material.envMapIntensity = 0
    material.toneMapped = false
    if (emissiveLum < 1e-4) {
      material.emissive.setRGB(1, 1, 1)
    }
    // Scene author intensity (fire ~6). Slight bump so HDR tone-map still reads hot.
    material.emissiveIntensity = Math.max(intensity, intensity * 1.15)
    if (alphaBlend || mapLessClickRing) {
      material.transparent = true
      // Rings must not write depth or fog/cover planes hide them under top-down VC.
      material.depthWrite = false
    }
    material.blending = THREE.NormalBlending
    // Draw after terrain/fog so ALPHA_BLEND discs stay visible.
    material.depthTest = true
    applyDirectIntensity(material, 0)
    return
  }

  // Opaque shared albedo+emissive (asset-pack floors): lit diffuse is primary;
  // keep a soft bake only — full intensity on both channels washes + blooms out.
  if (sharedAlbedoEmissive && !alphaBlend) {
    if (material.emissive.r + material.emissive.g + material.emissive.b < 1e-4) {
      material.emissive.setRGB(1, 1, 1)
    }
    // Cap bake so outdoor sun + emissiveMap don't overexpose tiles.
    const bake = Math.min(Math.max(intensity, 0), 2) * 0.22
    material.emissiveIntensity = bake
    material.toneMapped = true
    if (material.blending !== THREE.NormalBlending) {
      material.blending = THREE.NormalBlending
    }
    return
  }

  material.toneMapped = intensity <= 1.5
  if (material.blending !== THREE.NormalBlending) {
    material.blending = THREE.NormalBlending
  }
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
  // Soft outdoor response (Unity Explorer lit feel): less mirror, higher roughness floor.
  // Creator Hub often stamps metallic/roughness 0.5 — treat as mid, not chrome.
  const metalIn = pbr.metallic ?? 0.2
  const roughIn = pbr.roughness ?? 0.65
  material.metalness = Math.min(1, metalIn * 0.55)
  material.roughness = Math.min(1, Math.max(0.28, roughIn * 0.82 + 0.2))

  const spec = pbr.reflectivityColor ?? { r: 1, g: 1, b: 1 }
  material.specularColor.setRGB(spec.r ?? 1, spec.g ?? 1, spec.b ?? 1)
  material.specularIntensity = (pbr.specularIntensity ?? 1) * 0.65
  if (material.envMapIntensity === undefined || material.envMapIntensity === 1) {
    material.envMapIntensity = 0.4
  }

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

