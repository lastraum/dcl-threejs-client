import * as THREE from 'three'

const NEON_MATERIAL_NAME =
  /^light(?:led)?(?:visible)?$|light[_-]?led|emissive|glow|neon|_led$|light[_-]?strip/i
const BAKED_EMISSIVE_NAME = /bake|baked|lightmap|wallmodule|floor/i

function isStandardMaterial(mat: THREE.Material): mat is THREE.MeshStandardMaterial {
  return 'isMeshStandardMaterial' in mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial
}

/** Baked lighting often uses emissiveTexture + low factor — not neon strips. */
function isBakedEmissiveMaterial(mat: THREE.MeshStandardMaterial): boolean {
  const name = mat.name.toLowerCase()
  if (BAKED_EMISSIVE_NAME.test(name)) return true

  const intensity = mat.emissiveIntensity ?? 1
  if (!mat.emissiveMap || intensity > 1) return false

  const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b
  if (emissiveLuma > 1.5) return false
  if (NEON_MATERIAL_NAME.test(name)) return false

  return true
}

function isNeonEmissiveMaterial(mat: THREE.MeshStandardMaterial): boolean {
  if (isBakedEmissiveMaterial(mat)) return false

  const intensity = mat.emissiveIntensity ?? 1
  if (intensity > 1) return true

  const name = mat.name.toLowerCase()
  const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b
  return NEON_MATERIAL_NAME.test(name) && emissiveLuma > 0.12
}

function applyEmissiveOnlyLook(mat: THREE.MeshStandardMaterial): void {
  const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b
  if (emissiveLuma > 0.08) {
    // Unity LED exports duplicate tint in baseColor — diffuse reads as "whiter", not glowing.
    mat.color.setRGB(0, 0, 0)
  }
  mat.metalness = 0
  mat.roughness = 1
  mat.envMapIntensity = 0
  mat.toneMapped = false
}

function tuneNeonMaterial(mat: THREE.MeshStandardMaterial): void {
  if ((mat.userData as Record<string, unknown>).dclSceneNeonTuned) return

  const name = mat.name.toLowerCase()
  const intensity = mat.emissiveIntensity ?? 1

  applyEmissiveOnlyLook(mat)

  // KHR_materials_emissive_strength (e.g. opbadge LightLED ≈ 80).
  if (intensity > 1) {
    ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
    return
  }

  // Visible LED variants omit emissive_strength but pair with a high-strength sibling mat.
  if (/light.*visible|lightled/i.test(name)) {
    mat.emissiveIntensity = 40
    ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
    return
  }

  if (NEON_MATERIAL_NAME.test(name)) {
    mat.emissiveIntensity = Math.max(intensity, 8)
    ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
  }
}

/** Targeted neon parity for baked scene GLBs — does not boost wearable-style or baked emissive maps. */
export function applySceneGltfEmissives(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of materials) {
      if (!isStandardMaterial(mat)) continue
      if (!isNeonEmissiveMaterial(mat)) continue
      tuneNeonMaterial(mat)
    }
  })
}

export function isSceneNeonEmissiveMaterial(material: THREE.MeshStandardMaterial): boolean {
  return isNeonEmissiveMaterial(material)
}