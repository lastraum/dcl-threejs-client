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

/** Normalize emissive hue to 0–1; brightness lives in emissiveIntensity (Color clamps to white otherwise). */
function resolveNeonEmissive(mat: PbrMeshMaterial): { hue: THREE.Color; intensity: number } {
  const tint = mat.emissive.clone()
  const factorIntensity = mat.emissiveIntensity ?? 1
  const peak = Math.max(tint.r, tint.g, tint.b, 0.0001)
  const hue = tint.multiplyScalar(1 / peak)
  const radiance =
    factorIntensity > 1 ? peak * factorIntensity : peak * resolveNeonIntensity(mat)
  return { hue, intensity: Math.max(radiance, 1) }
}

function createNeonMaterial(mat: PbrMeshMaterial, opts: { emissiveMap?: THREE.Texture | null }): THREE.MeshStandardMaterial {
  const { hue, intensity } = resolveNeonEmissive(mat)

  const neon = new THREE.MeshStandardMaterial({
    name: mat.name,
    color: new THREE.Color(0, 0, 0),
    emissive: hue,
    emissiveIntensity: intensity,
    emissiveMap: opts.emissiveMap ?? null,
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

function tuneMappedNeonMaterial(mat: PbrMeshMaterial): void {
  if ((mat.userData as Record<string, unknown>).dclSceneNeonTuned) return

  const { hue, intensity } = resolveNeonEmissive(mat)
  mat.color.setRGB(0, 0, 0)
  mat.emissive.copy(hue)
  mat.emissiveIntensity = intensity
  mat.metalness = 0
  mat.roughness = 1
  mat.envMapIntensity = 0
  mat.toneMapped = false
  ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
}

function tuneNeonMaterial(mat: PbrMeshMaterial): THREE.Material {
  if ((mat.userData as Record<string, unknown>).dclSceneNeonTuned) return mat

  if (!mat.emissiveMap) return createNeonMaterial(mat, {})

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