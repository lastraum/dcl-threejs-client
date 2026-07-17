import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBGltfNodeModifiers } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/gltf_node_modifiers.gen'
import type { MaterialApplier, PbMaterial } from './material/MaterialApplier'

/**
 * Resolve GLTF meshes under an entity for GltfNodeModifiers.path.
 * - `""` → all Mesh nodes under the entity (global modifier)
 * - `"Name"` / `"a/b/Name"` → match by node name (leaf) or full hierarchy path
 */
export function resolveGltfModifierMeshes(
  entityRoot: THREE.Object3D,
  path: string
): THREE.Mesh[] {
  const trimmed = path?.trim() ?? ''
  const out: THREE.Mesh[] = []

  // Prefer the GLB visual root (`__mesh_${entity}`) when present.
  const visual =
    entityRoot.children.find((c) => c.name.startsWith('__mesh_')) ?? entityRoot

  if (!trimmed) {
    visual.traverse((obj) => {
      if ((obj as THREE.Mesh).isMesh) out.push(obj as THREE.Mesh)
    })
    return out
  }

  const leaf = trimmed.split('/').filter(Boolean).pop() ?? trimmed
  visual.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    if (obj.name === trimmed || obj.name === leaf) {
      out.push(obj as THREE.Mesh)
      return
    }
    // Hierarchy path from visual root (Unity/Babylon style).
    const hierarchy: string[] = []
    let cur: THREE.Object3D | null = obj
    while (cur && cur !== visual) {
      hierarchy.unshift(cur.name)
      cur = cur.parent
    }
    if (hierarchy.join('/') === trimmed || hierarchy.join('/') === leaf) {
      out.push(obj as THREE.Mesh)
    }
  })
  return out
}

export function gltfNodeModifiersReferenceVideo(
  mods: PBGltfNodeModifiers,
  videoPlayerEntity: Entity
): boolean {
  for (const mod of mods.modifiers ?? []) {
    const mat = mod.material as PbMaterial | undefined
    if (!mat?.material) continue
    const inner =
      mat.material.$case === 'pbr'
        ? mat.material.pbr
        : mat.material.$case === 'unlit'
          ? mat.material.unlit
          : undefined
    if (!inner) continue
    const slots = [inner.texture, (inner as { alphaTexture?: unknown }).alphaTexture]
    if (mat.material.$case === 'pbr') {
      const pbr = mat.material.pbr
      slots.push(pbr.emissiveTexture, pbr.bumpTexture)
    }
    for (const slot of slots) {
      const tex = (slot as { tex?: { $case?: string; videoTexture?: { videoPlayerEntity?: number } } })
        ?.tex
      if (tex?.$case === 'videoTexture' && tex.videoTexture?.videoPlayerEntity === (videoPlayerEntity as number)) {
        return true
      }
    }
  }
  return false
}

/**
 * Apply GltfNodeModifiers materials / castShadows to meshes already attached under the entity.
 * Returns true when all material slots resolved (video textures ready).
 */
export async function applyGltfNodeModifiersToEntity(
  entityRoot: THREE.Object3D,
  mods: PBGltfNodeModifiers,
  materials: MaterialApplier
): Promise<boolean> {
  let allOk = true
  for (const mod of mods.modifiers ?? []) {
    const targets = resolveGltfModifierMeshes(entityRoot, mod.path ?? '')
    if (!targets.length) {
      // Path miss is not fatal — keep pending if material needs video later.
      if (mod.material) allOk = false
      continue
    }
    if (mod.castShadows !== undefined) {
      for (const mesh of targets) mesh.castShadow = mod.castShadows
    }
    if (!mod.material) continue
    const pb = mod.material as PbMaterial
    for (const mesh of targets) {
      // GLTF video screens: DoubleSide so the plane is visible from either approach.
      if (materialHasVideoTexture(pb)) {
        mesh.userData.primitiveDoubleSided = true
      }
      const ok = await materials.applyToMesh(mesh, pb)
      if (!ok) allOk = false
    }
  }
  return allOk
}

function materialHasVideoTexture(pb: PbMaterial): boolean {
  const inner =
    pb.material?.$case === 'pbr'
      ? pb.material.pbr
      : pb.material?.$case === 'unlit'
        ? pb.material.unlit
        : undefined
  if (!inner) return false
  return (inner.texture as { tex?: { $case?: string } } | undefined)?.tex?.$case === 'videoTexture'
}

