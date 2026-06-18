import * as THREE from 'three'

const NEON_MATERIAL_NAME =
  /^light(?:led)?(?:visible)?$|light[_-]?led|emissive|glow|neon|_led$|light[_-]?strip/i
const BAKED_EMISSIVE_NAME = /bake|baked|lightmap|wallmodule|floor/i

type PbrMeshMaterial = THREE.MeshStandardMaterial | THREE.MeshPhysicalMaterial

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

function isNeonEmissiveMaterial(mat: PbrMeshMaterial): boolean {
  if (isBakedEmissiveMaterial(mat)) return false

  const intensity = mat.emissiveIntensity ?? 1
  if (intensity > 1) return true

  const name = mat.name.toLowerCase()
  const emissiveLuma = mat.emissive.r + mat.emissive.g + mat.emissive.b
  return NEON_MATERIAL_NAME.test(name) && emissiveLuma > 0.12
}

function resolveNeonIntensity(mat: PbrMeshMaterial): number {
  const intensity = mat.emissiveIntensity ?? 1
  const name = mat.name.toLowerCase()

  if (intensity > 1) return intensity
  if (/light.*visible|lightled/i.test(name)) return 40
  if (NEON_MATERIAL_NAME.test(name)) return Math.max(intensity, 8)
  return intensity
}

/** Solid-color scene LEDs — unlit so sun/hemi cannot wash them to white diffuse. */
function toUnlitNeonMaterial(mat: PbrMeshMaterial): THREE.MeshBasicMaterial {
  const tint = mat.emissive.clone()
  tint.multiplyScalar(resolveNeonIntensity(mat))

  const basic = new THREE.MeshBasicMaterial({
    name: mat.name,
    color: tint,
    toneMapped: false,
    side: mat.side,
    transparent: mat.transparent,
    opacity: mat.opacity,
    depthWrite: mat.depthWrite
  })
  ;(basic.userData as Record<string, unknown>).dclSceneNeonTuned = true
  mat.dispose()
  return basic
}

function tuneMappedNeonMaterial(mat: PbrMeshMaterial): void {
  if ((mat.userData as Record<string, unknown>).dclSceneNeonTuned) return

  mat.color.setRGB(0, 0, 0)
  mat.emissiveIntensity = resolveNeonIntensity(mat)
  mat.metalness = 0
  mat.roughness = 1
  mat.envMapIntensity = 0
  mat.toneMapped = false
  ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
}

function tuneNeonMaterial(mat: PbrMeshMaterial): THREE.Material {
  if ((mat.userData as Record<string, unknown>).dclSceneNeonTuned) return mat

  if (!mat.emissiveMap) return toUnlitNeonMaterial(mat)

  tuneMappedNeonMaterial(mat)
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