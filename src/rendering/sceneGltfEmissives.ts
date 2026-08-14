import * as THREE from 'three'

/**
 * Legacy name hints for plaza LED strips that ship without KHR_materials_emissive_strength.
 * Prefer property-based detection below; do not add scene/VFX name lists here.
 */
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

function emissiveLuma(mat: PbrMeshMaterial): number {
  return mat.emissive.r + mat.emissive.g + mat.emissive.b
}

/** Opaque surface with albedo reused as emissiveMap — Creator Hub floor/wall bake, not a sprite. */
function isOpaqueSharedAlbedoEmissive(mat: PbrMeshMaterial): boolean {
  if (!mat.map || mat.map !== mat.emissiveMap) return false
  if (mat.transparent || mat.opacity < 0.98) return false
  if ((mat.alphaTest ?? 0) > 0) return false
  return true
}

/** Baked lighting often uses emissiveTexture + low factor — not neon strips. */
function isBakedEmissiveMaterial(mat: PbrMeshMaterial): boolean {
  const name = mat.name.toLowerCase()
  if (BAKED_EMISSIVE_NAME.test(name)) return true
  // HexagonFloor / asset-pack tiles: albedo slot == emissiveTexture on opaque mesh.
  // Must not enter neon/glow (toneMapped=false + bloom → washed white floors).
  if (isOpaqueSharedAlbedoEmissive(mat)) return true

  const intensity = mat.emissiveIntensity ?? 1
  if (!mat.emissiveMap || intensity > 1) return false

  if (emissiveLuma(mat) > 1.5) return false
  if (NEON_MATERIAL_NAME.test(name)) return false

  return true
}

/**
 * Shared map + emissiveMap at high intensity — flame/LED sprites only.
 * Opaque floors/walls that reuse albedo as emissiveTexture are baked (not sprites).
 */
function isGlowSpriteMaterial(mat: PbrMeshMaterial): boolean {
  const intensity = mat.emissiveIntensity ?? 1
  if (intensity < 1.5 || !mat.emissiveMap) return false
  if (!mat.map) return true
  if (mat.map !== mat.emissiveMap) return false
  // Transparent / cutout cards (firepit, LED sheets) — glow sprite.
  // Opaque shared map (HexagonFloor tiles) — never.
  if (isOpaqueSharedAlbedoEmissive(mat)) return false
  return mat.transparent || mat.opacity < 0.98 || (mat.alphaTest ?? 0) > 0
}

/**
 * glTF mesh that self-illuminates from authored emissiveFactor without relying on diffuse.
 * Property-based: no albedo/emissive maps + non-trivial emissiveFactor (e.g. GunVFX ShootVFX).
 * Scene code does not need node modifiers — the GLB carries the emissive.
 */
function isUntexturedEmissiveMaterial(mat: PbrMeshMaterial): boolean {
  if (mat.map || mat.emissiveMap) return false
  return emissiveLuma(mat) > 0.05
}

function isNeonEmissiveMaterial(mat: PbrMeshMaterial): boolean {
  if (isBakedEmissiveMaterial(mat)) return false

  const intensity = mat.emissiveIntensity ?? 1
  const name = mat.name.toLowerCase()
  const luma = emissiveLuma(mat)

  // Authored untextured emissive (glTF emissiveFactor only) — Explorer shows as glow.
  if (isUntexturedEmissiveMaterial(mat)) return true

  if (NEON_MATERIAL_NAME.test(name) && (luma > 0.12 || intensity > 1)) return true

  // KHR_materials_emissive_strength on albedo-textured meshes — not neon strips.
  if (mat.map && intensity > 1 && !isGlowSpriteMaterial(mat)) return false

  return isGlowSpriteMaterial(mat)
}

/**
 * Authored DCL emissive: clamp color to [0,1], intensity = KHR strength or HDR peak fold.
 * Bloom is a post filter — do not invent a second intensity table.
 */
function resolveNeonEmissive(mat: PbrMeshMaterial): { color: THREE.Color; intensity: number } {
  const raw = mat.emissive
  const peak = Math.max(raw.r, raw.g, raw.b, 0.0001)

  const color =
    peak > 1
      ? new THREE.Color(
          THREE.MathUtils.clamp(raw.r / peak, 0, 1),
          THREE.MathUtils.clamp(raw.g / peak, 0, 1),
          THREE.MathUtils.clamp(raw.b / peak, 0, 1)
        )
      : clampEmissiveColor(raw)

  const loaded = mat.emissiveIntensity ?? 1
  const intensity = loaded > 1 ? loaded : peak > 1 ? peak : 1
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
  mat.toneMapped = true
  if (mat.blending !== THREE.NormalBlending) mat.blending = THREE.NormalBlending
  ;(mat.userData as Record<string, unknown>).dclSceneNeonTuned = true
  delete (mat.userData as Record<string, unknown>).dclUntexturedGlowBlend
  return { color, intensity }
}

function createNeonMaterial(mat: PbrMeshMaterial): THREE.Material {
  const { color, intensity } = resolveNeonEmissive(mat)
  const neon = new THREE.MeshStandardMaterial({
    name: mat.name,
    color: new THREE.Color(0, 0, 0),
    emissive: color,
    emissiveIntensity: intensity,
    toneMapped: true,
    metalness: 0,
    roughness: 1,
    envMapIntensity: 0,
    vertexColors: mat.vertexColors,
    side: mat.side,
    transparent: mat.transparent,
    opacity: mat.opacity,
    depthWrite: mat.depthWrite
  })
  ;(neon.userData as Record<string, unknown>).dclSceneNeonTuned = true
  mat.dispose()
  return neon
}

/** Session-cached additive MeshBasic + bloom stacked to white — restore unlit authored color. */
function neutralizeLegacyGlowBasic(mat: THREE.MeshBasicMaterial): THREE.MeshBasicMaterial {
  const ud = mat.userData as Record<string, unknown>
  if (!ud.dclUntexturedGlowBlend) return mat
  mat.blending = THREE.NormalBlending
  mat.transparent = mat.opacity < 0.98
  mat.depthWrite = true
  mat.toneMapped = true
  mat.fog = true
  delete ud.dclUntexturedGlowBlend
  mat.needsUpdate = true
  return mat
}

function tuneNeonMaterial(mat: PbrMeshMaterial): THREE.Material {
  const ud = mat.userData as Record<string, unknown>
  if (ud.dclSceneNeonTuned && !ud.dclUntexturedGlowBlend) {
    mat.toneMapped = true
    if (mat.blending !== THREE.NormalBlending) mat.blending = THREE.NormalBlending
    return mat
  }

  if (!mat.emissiveMap) {
    if (mat.map) {
      const { color, intensity } = resolveNeonEmissive(mat)
      mat.emissive.copy(color)
      mat.emissiveIntensity = intensity
      mat.toneMapped = true
      ud.dclSceneNeonTuned = true
      delete ud.dclUntexturedGlowBlend
      return mat
    }
    return createNeonMaterial(mat)
  }

  applyNeonEmissive(mat)
  return mat
}

/**
 * Soft bake for opaque floors/walls that reuse albedo as emissiveMap.
 * Leaves material as standard PBR (tone-mapped) with a small self-lit contribution.
 */
function softBakeOpaqueSharedEmissive(mat: PbrMeshMaterial): void {
  const ud = mat.userData as Record<string, unknown>
  if (ud.dclOpaqueSharedBake) return
  const intensity = mat.emissiveIntensity ?? 1
  if (emissiveLuma(mat) < 1e-4) {
    mat.emissive.setRGB(1, 1, 1)
  }
  // KHR strength can be 5–80 on asset-pack tiles — clamp so sun + bake don't wash out.
  const bake = Math.min(Math.max(intensity, 0), 2) * 0.22
  mat.emissiveIntensity = bake
  mat.toneMapped = true
  if (mat.blending !== THREE.NormalBlending) mat.blending = THREE.NormalBlending
  ud.dclOpaqueSharedBake = true
  mat.needsUpdate = true
}

/**
 * Apply DCL emissive parity to materials on a loaded GLB.
 * Driven by glTF material properties (emissiveFactor, maps, KHR strength) — not scene-specific names.
 * ECS Material / GltfNodeModifiers go through MaterialApplier separately.
 */
export function applySceneGltfEmissives(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return

    const replaceMaterial = (mat: THREE.Material): THREE.Material => {
      if (mat instanceof THREE.MeshBasicMaterial) {
        return neutralizeLegacyGlowBasic(mat)
      }
      if (!isPbrMeshMaterial(mat)) return mat
      // Floor tiles: always soft-bake shared albedo/emissive (even if not "neon").
      if (isOpaqueSharedAlbedoEmissive(mat)) {
        softBakeOpaqueSharedEmissive(mat)
        return mat
      }
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
