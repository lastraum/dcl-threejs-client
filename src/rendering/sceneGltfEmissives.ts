import * as THREE from 'three'

const NEON_MATERIAL_NAME =
  /^light(?:led)?(?:visible)?$|light[_-]?led|emissive|glow|neon|_led$|light[_-]?strip/i
const BAKED_EMISSIVE_NAME = /bake|baked|lightmap|wallmodule|floor/i

type PbrMeshMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial

/**
 * DCL PBR emissive model (matches Unity MaterialPropertyBlock / PBREmissive):
 * - emissive **color** RGB is clamped to [0, 1] per channel (Color4 α also clamped to 1)
 * - emissive **intensity** is a separate scalar — 0+, often 2–4 or KHR emissive_strength (e.g. 80)
 * - final radiance = clampedColor * intensity (Three.js: emissive * emissiveIntensity)
 *
 * Do NOT fold intensity into color — THREE.Color clamps to white and kills hue.
 */
function clampEmissiveColor(source: THREE.Color): THREE.Color {
  return new THREE.Color(
    THREE.MathUtils.clamp(source.r, 0, 1),
    THREE.MathUtils.clamp(source.g, 0, 1),
    THREE.MathUtils.clamp(source.b, 0, 1)
  )
}

function isPbrMeshMaterial(mat: THREE.Material): mat is PbrMeshMaterial {
  return (
    ('isMeshStandardMaterial' in mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial) ||
    ('isMeshPhysicalMaterial' in mat && (mat as THREE.MeshPhysicalMaterial).isMeshPhysicalMaterial)
  )
}

/** Baked lighting often uses emissiveTexture + low factor — not neon strips. */
function isBakedEmissiveMaterial(mat: PbrMeshMaterial): boolean {
  const name = mat.name.toLowerCase()
  if (BAKED_EMISSIVE_NAME.test(name)) return true

  const intensity = mat.emissiveIntensity ?? 1
  if (!mat.emissiveMap || intensity > 1) return false

  const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b
  if (emissiveLuma > 1.5) return false
  if (NEON_MATERIAL_NAME.test(name)) return false

  return true
}

/** Shared map + emissiveMap at high intensity — flame/LED sprites (not textured facades). */
function isGlowSpriteMaterial(mat: PbrMeshMaterial): boolean {
  const intensity = mat.emissiveIntensity ?? 1
  if (intensity < 1.5 || !mat.emissiveMap) return false
  if (!mat.map) return true
  return mat.map === mat.emissiveMap
}

function isNeonEmissiveMaterial(mat: PbrMeshMaterial): boolean {
  if (isBakedEmissiveMaterial(mat)) return false

  const intensity = mat.emissiveIntensity ?? 1
  const name = mat.name.toLowerCase()
  const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b

  if (NEON_MATERIAL_NAME.test(name) && (emissiveLuma > 0.12 || intensity > 1)) return true

  // KHR_materials_emissive_strength on albedo-textured meshes — not neon strips.
  if (mat.map && intensity > 1 && !isGlowSpriteMaterial(mat)) return false

  return isGlowSpriteMaterial(mat)
}

/** Fallback intensity when glTF omits KHR_materials_emissive_strength on named neon mats. */
function fallbackNeonIntensity(mat: PbrMeshMaterial): number {
  const name = mat.name.toLowerCase()
  if (/light.*visible|lightled/i.test(name)) return 40
  if (NEON_MATERIAL_NAME.test(name)) return 8
  return 1
}

function resolveNeonEmissive(mat: PbrMeshMaterial): { color: THREE.Color; intensity: number } {
  const raw = mat.emissive
  const peak = Math.max(raw.r, raw.g, raw.b, 0.0001)

  // HDR emissive factors (>1) — preserve hue, fold excess into intensity (DCL clamps color only).
  const color =
    peak > 1
      ? new THREE.Color(
          THREE.MathUtils.clamp(raw.r / peak, 0, 1),
          THREE.MathUtils.clamp(raw.g / peak, 0, 1),
          THREE.MathUtils.clamp(raw.b / peak, 0, 1)
        )
      : clampEmissiveColor(raw)

  const loaded = mat.emissiveIntensity ?? 1
  let intensity: number
  if (loaded > 1) {
    // KHR_materials_emissive_strength — already the DCL intensity scalar
    intensity = loaded
  } else if (peak > 1) {
    // HDR baked into emissive factor — fold into intensity, not color
    intensity = peak
  } else {
    intensity = fallbackNeonIntensity(mat)
  }

  return { color, intensity }
}

function applyNeonEmissive(mat: PbrMeshMaterial): { color: THREE.Color; intensity: number } {
  const { color, intensity } = resolveNeonEmissive(mat)
  const emissiveOnly = !mat.map || mat.map === mat.emissiveMap
  if (emissiveOnly) {
    mat.color.setRGB(0, 0, 0)
    mat.metalness = 0
    mat.roughness = 1
    mat.envMapIntensity = 0
  }
  mat.emissive.copy(color)
  mat.emissiveIntensity = intensity
  mat.toneMapped = false
  ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
  return { color, intensity }
}

function createNeonMaterial(mat: PbrMeshMaterial): THREE.MeshStandardMaterial {
  const { color, intensity } = resolveNeonEmissive(mat)

  const neon = new THREE.MeshStandardMaterial({
    name: mat.name,
    color: new THREE.Color(0, 0, 0),
    emissive: color,
    emissiveIntensity: intensity,
    toneMapped: false,
    metalness: 0,
    roughness: 1,
    envMapIntensity: 0,
    side: mat.side,
    transparent: mat.transparent,
    opacity: mat.opacity,
    depthWrite: mat.depthWrite
  })
  ;(neon.userData as Record<string, unknown>).dclSceneNeonTuned = true
  mat.dispose()
  return neon
}

function tuneNeonMaterial(mat: PbrMeshMaterial): THREE.Material {
  if ((mat.userData as Record<string, unknown>).dclSceneNeonTuned) return mat

  if (!mat.emissiveMap) {
    if (mat.map) {
      const { color, intensity } = resolveNeonEmissive(mat)
      mat.emissive.copy(color)
      mat.emissiveIntensity = intensity
      mat.toneMapped = intensity > 1.5
      ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
      return mat
    }
    return createNeonMaterial(mat)
  }

  applyNeonEmissive(mat)
  return mat
}

/** Targeted neon parity for baked scene GLBs — does not boost baked emissive lightmaps. */
export function applySceneGltfEmissives(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return

    const replaceMaterial = (mat: THREE.Material): THREE.Material => {
      if (!isPbrMeshMaterial(mat)) return mat
      if (!isNeonEmissiveMaterial(mat)) return mat
      return tuneNeonMaterial(mat)
    }

    if (Array.isArray(obj.material)) {
      obj.material = obj.material.map(replaceMaterial)
      return
    }
    obj.material = replaceMaterial(obj.material)
  })
}

export function isSceneNeonEmissiveMaterial(material: THREE.MeshStandardMaterial): boolean {
  return isNeonEmissiveMaterial(material)
}