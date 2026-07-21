import * as THREE from 'three'
import { renderQuality } from '../rendering/RenderQualitySettings'
import { EMISSIVE_FACTOR_BOOST, EMISSIVE_INTENSITY } from './constants'

const EMISSIVE_NAME = /^em\.|emissive|glow|neon|em_/

/**
 * Official DCL avatar toon banding, ported from wearable-preview
 * (src/lib/babylon/toon/new-pbr.hlsl): posterize the FINAL composed color into 4 bands.
 * t = (N·ray + 1)/2; thresholds 0.90/0.20 → multipliers 1.2 / 1.0 / 0.8.
 * The ×0.8 floor keeps garment interiors from reading as black voids under PBR.
 */
const TOON_BAND_CHUNK = /* glsl */ `
  {
    float toonT = ( dot( normal, normalize( vViewPosition ) ) + 1.0 ) * 0.5;
    float toonBand = toonT > 0.9 ? 1.2 : ( toonT > 0.2 ? 1.0 : 0.8 );
    // Lift the lit result toward flat albedo, then band — official shading is nearly
    // unlit; pure outgoingLight kept too much three.js light contrast.
    outgoingLight = mix( outgoingLight, diffuseColor.rgb, 0.6 ) * toonBand;
  }
`

/**
 * Whether avatar toon is active for this session.
 * Preferences default off; URL `?avatartoon` forces on, `?avatarnotoon` forces off (A/B).
 */
export function isAvatarToonEnabled(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const q = new URLSearchParams(window.location.search)
      if (q.has('avatarnotoon')) return false
      if (q.has('avatartoon')) return true
    }
  } catch {
    /* ignore */
  }
  return renderQuality.getAvatarToonEnabled()
}

/** Match the official matte/toon avatar look — banded color, no specular response. */
export function applyAvatarToonShading(root: THREE.Object3D): void {
  if (!isAvatarToonEnabled()) return
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of materials) {
      if (!isStandardMaterial(mat)) continue
      const userData = mat.userData as Record<string, unknown>
      if (userData.dclToon) continue
      userData.dclToon = true
      if (!userData.dclEmissiveBoosted) {
        mat.metalness = 0
        mat.roughness = Math.max(mat.roughness, 0.9)
        mat.envMapIntensity = 0
      }
      mat.onBeforeCompile = (shader) => {
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <opaque_fragment>',
          `${TOON_BAND_CHUNK}\n#include <opaque_fragment>`
        )
      }
      mat.needsUpdate = true
    }
  })
}

function isStandardMaterial(mat: THREE.Material): mat is THREE.MeshStandardMaterial {
  return 'isMeshStandardMaterial' in mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial
}

function applyHex(mat: THREE.MeshStandardMaterial, hex: string): void {
  mat.color.set(`#${hex}`)
  mat.metalness = 0
  mat.roughness = 1
}

function resolveEmissiveTint(mat: THREE.MeshStandardMaterial): THREE.Color {
  const tint = new THREE.Color()
  const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b
  const colorLuma = mat.color.r + mat.color.g + mat.color.b

  if (emissiveLuma > 0.01) {
    tint.copy(mat.emissive)
  } else if (colorLuma > 0.01) {
    tint.copy(mat.color)
  } else if (mat.emissiveMap) {
    // Mask-only emissive maps inherit tint from albedo when available.
    tint.setRGB(1, 1, 1)
  }
  return tint
}

function boostEmissiveColor(mat: THREE.MeshStandardMaterial, isEmNamed: boolean): void {
  if ((mat.userData as Record<string, unknown>).dclEmissiveBoosted) return

  const tint = resolveEmissiveTint(mat)
  if (tint.r + tint.g + tint.b < 0.001 && !mat.emissiveMap) return

  if (isEmNamed) {
    // Em.* mats store glow in baseColorFactor too — merge without summing (sum washes hue to white).
    tint.r = Math.max(tint.r, mat.color.r)
    tint.g = Math.max(tint.g, mat.color.g)
    tint.b = Math.max(tint.b, mat.color.b)
  } else if (mat.emissiveMap) {
    const colorLuma = mat.color.r + mat.color.g + mat.color.b
    const sharedColorMap = mat.map != null && mat.map === mat.emissiveMap
    if (sharedColorMap || colorLuma > 2.85) {
      tint.setRGB(1, 1, 1)
    } else if (colorLuma > 0.01) {
      tint.copy(mat.color)
    }
    tint.multiplyScalar(Math.min(EMISSIVE_FACTOR_BOOST * 0.5, 2))
  } else {
    tint.multiplyScalar(EMISSIVE_FACTOR_BOOST)
  }

  // Preserve hue — brightness comes from emissiveIntensity, not per-channel clamp to 1.
  const peak = Math.max(tint.r, tint.g, tint.b, 0.0001)
  tint.multiplyScalar((isEmNamed ? 0.8 : 0.55) / peak)

  mat.emissive.copy(tint)
  mat.emissiveIntensity = Math.max(mat.emissiveIntensity, EMISSIVE_INTENSITY)
  mat.toneMapped = false
  mat.metalness = 0
  mat.roughness = Math.min(mat.roughness, 0.2)
  mat.envMapIntensity = 0
  ;(mat.userData as Record<string, unknown>).dclEmissiveBoosted = true
}

export function prepareAvatarMaterials(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of materials) {
      mat.side = THREE.DoubleSide
    }
    if (obj instanceof THREE.SkinnedMesh) obj.frustumCulled = false
  })
}

/** DCL wearables use emissiveFactor and/or Em.* materials for visors, neon trim, etc. */
export function applyWearableEmissives(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of materials) {
      if (!isStandardMaterial(mat)) continue

      const name = mat.name.toLowerCase()
      const isEmNamed = EMISSIVE_NAME.test(name)
      const hasEmissiveMap = !!mat.emissiveMap
      const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b

      // Plain materials with a faint emissiveFactor are authored sheen, not neon —
      // the boost peak-normalizes to full glow (×EMISSIVE_INTENSITY, untone-mapped),
      // which blew subtle factors out to solid white (e.g. GalaxyBoots at 0.07 peak).
      // Only boost unnamed/map-less materials when the factor is genuinely strong.
      if (!isEmNamed && !hasEmissiveMap && emissiveLuma <= 0.45) continue

      boostEmissiveColor(mat, isEmNamed)
    }
  })
}

export function tintWearableMaterials(root: THREE.Object3D, skin?: string, hair?: string): void {
  if (!skin && !hair) return
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    // SkeletonUtils / AssetCache share materials — clone before skin/hair tint.
    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map((m) => m.clone())
    } else {
      obj.material = obj.material.clone()
    }
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of materials) {
      if (!isStandardMaterial(mat)) continue
      const name = mat.name.toLowerCase()
      if (EMISSIVE_NAME.test(name)) continue
      if (name.includes('hair') && hair) applyHex(mat, hair)
      if (name.includes('skin') && skin) applyHex(mat, skin)
    }
  })
}

export function hexToColor(hex: string): THREE.Color {
  return new THREE.Color(`#${hex.replace('#', '')}`)
}

/** Warm lip tone derived from skin — Forge `getLipColor`. */
export function lipColorFromSkin(skinHex: string): THREE.Color {
  const skin = hexToColor(skinHex)
  return new THREE.Color(
    Math.min(skin.r * 0.88, 1),
    skin.g * 0.68,
    skin.b * 0.58
  )
}
