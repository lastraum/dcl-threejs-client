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
 * Fallback intensity when glTF omits KHR_materials_emissive_strength.
 * Explorer/Unity use bloom + different tonemap — without bloom, untextured
 * emissiveFactor (e.g. GunVFX ShootVFX 0.75) needs a higher intensity scalar
 * to read as a muzzle flash rather than matte gray (avatar path uses ~12).
 */
function fallbackNeonIntensity(mat: PbrMeshMaterial): number {
  const name = mat.name.toLowerCase()
  if (/light.*visible|lightled/i.test(name)) return 40
  if (NEON_MATERIAL_NAME.test(name)) return 8
  // Untextured emissiveFactor-only (muzzle / VFX cylinders) — boost for no-bloom clients.
  if (isUntexturedEmissiveMaterial(mat)) {
    const luma = emissiveLuma(mat)
    // Mid-range factors (0.3–1) → punchy flash; already-bright HDR factors stay moderate.
    if (luma >= 1.5) return 6
    if (luma >= 0.4) return 12
    return 8
  }
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

/**
 * Soft energy glow without full-scene bloom (Explorer uses bloom post).
 * Additive + no depth write so untextured VFX (muzzle flash) read as light,
 * not a solid bright mesh.
 */
function applyUntexturedGlowBlend(mat: THREE.MeshStandardMaterial): void {
  mat.blending = THREE.AdditiveBlending
  mat.transparent = true
  mat.depthWrite = false
  mat.toneMapped = false
  // Keep near-opaque so morph silhouettes stay readable; additive still softens stack-up.
  if (mat.opacity >= 0.99) mat.opacity = 0.92
  mat.needsUpdate = true
  ;(mat.userData as Record<string, unknown>).dclUntexturedGlowBlend = true
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

/**
 * Untextured emissive VFX → additive MeshBasicMaterial.
 * MeshStandard still does diffuse/specular lighting, so high emissiveIntensity only looks
 * "brighter plastic"; Basic + Additive is the classic muzzle/laser energy look without bloom.
 */
function createUntexturedGlowMaterial(mat: PbrMeshMaterial): THREE.MeshBasicMaterial {
  const { color, intensity } = resolveNeonEmissive(mat)
  // Fold intensity into color for Basic (no emissiveIntensity channel).
  const peak = Math.max(color.r, color.g, color.b, 0.0001)
  const scale = Math.min(intensity, 16)
  const glow = new THREE.MeshBasicMaterial({
    name: mat.name,
    color: new THREE.Color(
      (color.r / peak) * scale,
      (color.g / peak) * scale,
      (color.b / peak) * scale
    ),
    toneMapped: false,
    transparent: true,
    opacity: 0.9,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: mat.side,
    vertexColors: mat.vertexColors,
    fog: false
  })
  ;(glow.userData as Record<string, unknown>).dclSceneNeonTuned = true
  ;(glow.userData as Record<string, unknown>).dclUntexturedGlowBlend = true
  mat.dispose()
  return glow
}

function createNeonMaterial(mat: PbrMeshMaterial): THREE.Material {
  // Map-less emissiveFactor materials (GunVFX ShootVFX) — additive basic glow.
  if (isUntexturedEmissiveMaterial(mat)) {
    return createUntexturedGlowMaterial(mat)
  }

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

function retuneUntexturedGlow(mat: THREE.Material): THREE.Material {
  if (mat instanceof THREE.MeshBasicMaterial) {
    if ((mat.userData as Record<string, unknown>).dclUntexturedGlowBlend) {
      // Already additive basic — ensure blend flags stuck after share/clone.
      mat.blending = THREE.AdditiveBlending
      mat.transparent = true
      mat.depthWrite = false
      mat.toneMapped = false
      mat.fog = false
      mat.needsUpdate = true
      return mat
    }
  }
  if (isPbrMeshMaterial(mat) && isUntexturedEmissiveMaterial(mat) && !mat.map && !mat.emissiveMap) {
    return createUntexturedGlowMaterial(mat)
  }
  return mat
}

function tuneNeonMaterial(mat: PbrMeshMaterial): THREE.Material {
  const ud = mat.userData as Record<string, unknown>
  // Re-tune session-cached materials that only got a brightness bump (still solid mesh).
  if (ud.dclSceneNeonTuned) {
    if (ud.dclUntexturedGlowBlend) return mat
    if (!mat.map && !mat.emissiveMap && isUntexturedEmissiveMaterial(mat)) {
      return createUntexturedGlowMaterial(mat)
    }
    return mat
  }

  if (!mat.emissiveMap) {
    if (mat.map) {
      const { color, intensity } = resolveNeonEmissive(mat)
      mat.emissive.copy(color)
      mat.emissiveIntensity = intensity
      mat.toneMapped = intensity <= 1.5
      ud.dclSceneNeonTuned = true
      return mat
    }
    return createNeonMaterial(mat)
  }

  applyNeonEmissive(mat)
  // High-intensity emissive sprites (shared map) also read better additive.
  if (isGlowSpriteMaterial(mat)) {
    applyUntexturedGlowBlend(mat)
  }
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
      // MeshBasic from a prior untextured-glow pass — keep blend flags healthy.
      if (mat instanceof THREE.MeshBasicMaterial) {
        return retuneUntexturedGlow(mat)
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
