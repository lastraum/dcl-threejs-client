import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBGltfNodeModifiers } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/gltf_node_modifiers.gen'
import type { MaterialApplier, PbMaterial } from './material/MaterialApplier'

const ORIG_MAT_KEY = 'dclGltfNodeModOriginalMaterial'
const ORIG_CAST_KEY = 'dclGltfNodeModOriginalCastShadow'
const APPLIED_SIG_KEY = 'dclGltfNodeModAppliedSig'

/**
 * Resolve GLTF meshes under an entity for GltfNodeModifiers.path (SDK / Explorer parity).
 *
 * - `""` → all Mesh / SkinnedMesh nodes under the GLB visual root (global modifier)
 * - `"MeshName"` → match node name or mesh name (leaf)
 * - `"Parent/Child/Mesh"` → hierarchy path from visual root (Babylon-style)
 * - Leading `/` stripped; matching is case-sensitive first, then case-insensitive fallback
 */
export function resolveGltfModifierMeshes(
  entityRoot: THREE.Object3D,
  path: string
): THREE.Mesh[] {
  const trimmed = normalizeModifierPath(path)
  const visual = gltfVisualRoot(entityRoot)
  const out: THREE.Mesh[] = []

  if (!trimmed) {
    visual.traverse((obj) => {
      if (isRenderMesh(obj)) out.push(obj as THREE.Mesh)
    })
    return out
  }

  const candidates = collectMeshesWithPaths(visual)
  // Exact path / leaf
  for (const c of candidates) {
    if (c.path === trimmed || c.leaf === trimmed || c.name === trimmed) {
      out.push(c.mesh)
    }
  }
  if (out.length) return out

  // Case-insensitive fallback (Creator Hub / mixed export casing)
  const lower = trimmed.toLowerCase()
  for (const c of candidates) {
    if (
      c.path.toLowerCase() === lower ||
      c.leaf.toLowerCase() === lower ||
      c.name.toLowerCase() === lower
    ) {
      out.push(c.mesh)
    }
  }
  if (out.length) return out

  // Path ends with leaf, or path is a suffix of hierarchy
  for (const c of candidates) {
    if (c.path.endsWith('/' + trimmed) || c.path.toLowerCase().endsWith('/' + lower)) {
      out.push(c.mesh)
    }
  }
  return out
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

      if (mod.castShadows !== undefined) {
        mesh.castShadow = mod.castShadows
      }

      if (!mod.material) continue
      const pb = mod.material as PbMaterial

      // Video screens: visible from either side (Creator Hub plane GLBs).
      if (materialHasVideoTexture(pb)) {
        mesh.userData.primitiveDoubleSided = true
      }

      const ok = await materials.applyToMesh(mesh, pb)
      if (!ok) allOk = false
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

export function listValidMeshPaths(entityRoot: THREE.Object3D): string[] {
  return collectMeshesWithPaths(gltfVisualRoot(entityRoot)).map((c) => c.path || c.name)
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

type MeshPath = { mesh: THREE.Mesh; name: string; leaf: string; path: string }

function collectMeshesWithPaths(visual: THREE.Object3D): MeshPath[] {
  const out: MeshPath[] = []
  visual.traverse((obj) => {
    if (!isRenderMesh(obj)) return
    const hierarchy: string[] = []
    let cur: THREE.Object3D | null = obj
    while (cur && cur !== visual) {
      if (cur.name) hierarchy.unshift(cur.name)
      cur = cur.parent
    }
    const path = hierarchy.join('/')
    const leaf = hierarchy[hierarchy.length - 1] ?? obj.name
    out.push({ mesh: obj, name: obj.name, leaf, path })
  })
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
