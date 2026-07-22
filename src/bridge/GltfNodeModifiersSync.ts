import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBGltfNodeModifiers } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/gltf_node_modifiers.gen'
import type { MaterialApplier, PbMaterial } from './material/MaterialApplier'

const ORIG_MAT_KEY = 'dclGltfNodeModOriginalMaterial'
const ORIG_CAST_KEY = 'dclGltfNodeModOriginalCastShadow'
const APPLIED_SIG_KEY = 'dclGltfNodeModAppliedSig'

/**
 * Resolve GLTF meshes under an entity for GltfNodeModifiers.path.
 *
 * Scene-graph path resolution (same idea as Unity Transform.Find / glTF node paths):
 * - `""` → every Mesh under the visual root
 * - `"NodeName"` → every Object3D named NodeName under the visual root; take all
 *   Mesh descendants (covers Group targets like plaza `StoreBanners_LeftHorizontal`
 *   whose Mesh leaves are `Plane.059`)
 * - `"Parent/Child"` → walk named children from the visual root, then take Mesh descendants
 *
 * Case-sensitive first; if nothing matches, one case-insensitive retry.
 */
export function resolveGltfModifierMeshes(
  entityRoot: THREE.Object3D,
  path: string
): THREE.Mesh[] {
  const trimmed = normalizeModifierPath(path)
  const visual = gltfVisualRoot(entityRoot)

  if (!trimmed) {
    return collectDescendantMeshes(visual)
  }

  const segments = trimmed.split('/').filter(Boolean)
  const nodes = findNodesByPath(visual, segments, false)
  if (nodes.length) return collectMeshesUnderNodes(nodes)

  // Single case-insensitive pass for export casing drift (Creator Hub).
  const ciNodes = findNodesByPath(visual, segments, true)
  return collectMeshesUnderNodes(ciNodes)
}

export function gltfNodeModifiersReferenceVideo(
  mods: PBGltfNodeModifiers,
  videoPlayerEntity: Entity
): boolean {
  for (const mod of mods.modifiers ?? []) {
    if (materialReferencesVideoPlayer(mod.material as PbMaterial | undefined, videoPlayerEntity)) {
      return true
    }
  }
  return false
}

export function gltfNodeModifiersSignature(mods: PBGltfNodeModifiers): string {
  // Stable-enough dirty key for re-apply / skip
  try {
    return JSON.stringify(mods.modifiers ?? [])
  } catch {
    return String((mods.modifiers ?? []).length)
  }
}

/**
 * Apply GltfNodeModifiers materials / castShadows to meshes under the entity.
 * Caches original materials on first override so component removal can restore.
 * Returns true when all material slots resolved (e.g. video textures ready).
 */
export async function applyGltfNodeModifiersToEntity(
  entityRoot: THREE.Object3D,
  mods: PBGltfNodeModifiers,
  materials: MaterialApplier,
  opts?: { logPathMiss?: boolean; entity?: Entity }
): Promise<boolean> {
  const sig = gltfNodeModifiersSignature(mods)
  if (entityRoot.userData[APPLIED_SIG_KEY] === sig && !modifiersNeedVideoRetry(mods, materials)) {
    return true
  }

  let allOk = true
  const list = mods.modifiers ?? []

  for (const mod of list) {
    const targets = resolveGltfModifierMeshes(entityRoot, mod.path ?? '')
    if (!targets.length) {
      if (mod.material || mod.castShadows !== undefined) {
        allOk = false
        if (opts?.logPathMiss) {
          console.warn(
            '[GltfNodeModifiers] path not found on entity',
            opts.entity,
            JSON.stringify(mod.path),
            'valid:',
            listValidMeshPaths(entityRoot).slice(0, 24)
          )
        }
      }
      continue
    }

    for (const mesh of targets) {
      cacheOriginalAppearance(mesh)

      if (mod.material) {
        const pb = mod.material as PbMaterial

        // Video screens: visible from either side (Creator Hub plane GLBs).
        if (materialHasVideoTexture(pb)) {
          mesh.userData.primitiveDoubleSided = true
        }

        // gltfNodeModifier: static maps may need U flip on LH-mirrored GLB UVs (event boards).
        // Material apply also sets mesh.castShadow from Material.castShadows — path override below wins.
        const ok = await materials.applyToMesh(mesh, pb, { gltfNodeModifier: true })
        if (!ok) allOk = false
      }

      // Explicit GltfNodeModifiers.castShadows overrides Material (SDK path-level control).
      if (mod.castShadows !== undefined) {
        mesh.castShadow = mod.castShadows
      }
    }
  }

  if (allOk) {
    entityRoot.userData[APPLIED_SIG_KEY] = sig
  } else {
    delete entityRoot.userData[APPLIED_SIG_KEY]
  }
  return allOk
}

/** Restore materials/castShadows cached before the first GltfNodeModifiers apply. */
export function restoreGltfNodeModifierOriginals(entityRoot: THREE.Object3D): void {
  entityRoot.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const mesh = obj as THREE.Mesh
    if (mesh.userData[ORIG_MAT_KEY] !== undefined) {
      const current = mesh.material
      mesh.material = mesh.userData[ORIG_MAT_KEY] as THREE.Material | THREE.Material[]
      disposeMaterialIfOwned(current)
      delete mesh.userData[ORIG_MAT_KEY]
    }
    if (mesh.userData[ORIG_CAST_KEY] !== undefined) {
      mesh.castShadow = !!mesh.userData[ORIG_CAST_KEY]
      delete mesh.userData[ORIG_CAST_KEY]
    }
    delete mesh.userData.primitiveDoubleSided
  })
  delete entityRoot.userData[APPLIED_SIG_KEY]
}

/** Debug: named hierarchy paths for every mesh under the visual root. */
export function listValidMeshPaths(entityRoot: THREE.Object3D): string[] {
  const visual = gltfVisualRoot(entityRoot)
  const paths: string[] = []
  visual.traverse((obj) => {
    if (!isRenderMesh(obj)) return
    const hierarchy: string[] = []
    let cur: THREE.Object3D | null = obj
    while (cur && cur !== visual) {
      if (cur.name) hierarchy.unshift(cur.name)
      cur = cur.parent
    }
    paths.push(hierarchy.join('/') || obj.name || '(unnamed)')
  })
  return paths
}

// ── internals ──────────────────────────────────────────────────────────────

function normalizeModifierPath(path: string): string {
  return (path ?? '')
    .trim()
    .replace(/^\/+/, '')
    .replace(/\\/g, '/')
}

function gltfVisualRoot(entityRoot: THREE.Object3D): THREE.Object3D {
  return entityRoot.children.find((c) => c.name.startsWith('__mesh_')) ?? entityRoot
}

function isRenderMesh(obj: THREE.Object3D): obj is THREE.Mesh {
  return (obj as THREE.Mesh).isMesh === true
}

function namesEqual(a: string, b: string, ignoreCase: boolean): boolean {
  return ignoreCase ? a.toLowerCase() === b.toLowerCase() : a === b
}

/**
 * Walk the scene graph by successive child names.
 * One segment: any descendant named that segment (not only direct children).
 * Multiple segments: direct-child walk from each match of the first segment.
 */
function findNodesByPath(
  visual: THREE.Object3D,
  segments: string[],
  ignoreCase: boolean
): THREE.Object3D[] {
  if (segments.length === 0) return [visual]

  const [head, ...rest] = segments
  if (!head) return []

  // First segment: search the whole subtree (modifier paths name Groups anywhere under root).
  const heads: THREE.Object3D[] = []
  visual.traverse((obj) => {
    if (obj === visual) return
    if (obj.name && namesEqual(obj.name, head, ignoreCase)) heads.push(obj)
  })
  if (heads.length === 0) return []

  if (rest.length === 0) return heads

  // Remaining segments: direct-child name walk (hierarchy path).
  const results: THREE.Object3D[] = []
  for (const start of heads) {
    let cursors: THREE.Object3D[] = [start]
    for (const seg of rest) {
      const next: THREE.Object3D[] = []
      for (const cur of cursors) {
        for (const child of cur.children) {
          if (child.name && namesEqual(child.name, seg, ignoreCase)) next.push(child)
        }
      }
      cursors = next
      if (!cursors.length) break
    }
    results.push(...cursors)
  }
  return results
}

function collectDescendantMeshes(root: THREE.Object3D): THREE.Mesh[] {
  const out: THREE.Mesh[] = []
  root.traverse((obj) => {
    if (isRenderMesh(obj)) out.push(obj)
  })
  return out
}

function collectMeshesUnderNodes(nodes: THREE.Object3D[]): THREE.Mesh[] {
  const seen = new Set<THREE.Mesh>()
  const out: THREE.Mesh[] = []
  for (const node of nodes) {
    node.traverse((obj) => {
      if (!isRenderMesh(obj) || seen.has(obj)) return
      seen.add(obj)
      out.push(obj)
    })
  }
  return out
}

function cacheOriginalAppearance(mesh: THREE.Mesh): void {
  if (mesh.userData[ORIG_MAT_KEY] === undefined) {
    // Clone so later dispose of override materials doesn't free the original.
    const mat = mesh.material
    mesh.userData[ORIG_MAT_KEY] = Array.isArray(mat) ? mat.map((m) => m.clone()) : mat.clone()
  }
  if (mesh.userData[ORIG_CAST_KEY] === undefined) {
    mesh.userData[ORIG_CAST_KEY] = mesh.castShadow
  }
}

function disposeMaterialIfOwned(mat: THREE.Material | THREE.Material[] | undefined): void {
  if (!mat) return
  const list = Array.isArray(mat) ? mat : [mat]
  for (const m of list) {
    // Maps may be shared (video textures) — only dispose material, not map textures.
    m.dispose()
  }
}

function materialHasVideoTexture(pb: PbMaterial | undefined): boolean {
  const inner = materialInner(pb)
  if (!inner) return false
  return (inner.texture as { tex?: { $case?: string } } | undefined)?.tex?.$case === 'videoTexture'
}

function materialReferencesVideoPlayer(
  pb: PbMaterial | undefined,
  videoPlayerEntity: Entity
): boolean {
  const inner = materialInner(pb)
  if (!inner) return false
  const slots: unknown[] = [inner.texture, (inner as { alphaTexture?: unknown }).alphaTexture]
  if (pb?.material?.$case === 'pbr') {
    const pbr = pb.material.pbr
    slots.push(pbr.emissiveTexture, pbr.bumpTexture)
  }
  for (const slot of slots) {
    const tex = (slot as { tex?: { $case?: string; videoTexture?: { videoPlayerEntity?: number } } })
      ?.tex
    if (
      tex?.$case === 'videoTexture' &&
      tex.videoTexture?.videoPlayerEntity === (videoPlayerEntity as number)
    ) {
      return true
    }
  }
  return false
}

function materialInner(pb: PbMaterial | undefined) {
  if (!pb?.material) return undefined
  if (pb.material.$case === 'pbr') return pb.material.pbr
  if (pb.material.$case === 'unlit') return pb.material.unlit
  return undefined
}

function modifiersNeedVideoRetry(mods: PBGltfNodeModifiers, materials: MaterialApplier): boolean {
  for (const mod of mods.modifiers ?? []) {
    const pb = mod.material as PbMaterial | undefined
    if (!pb) continue
    if (materials.texturesPending(pb)) return true
  }
  return false
}
