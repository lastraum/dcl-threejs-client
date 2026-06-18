import * as THREE from 'three'
import { applyWearableEmissives } from '../avatar/materials'

function isStandardMaterial(mat: THREE.Material): mat is THREE.MeshStandardMaterial {
  return 'isMeshStandardMaterial' in mat && (mat as THREE.MeshStandardMaterial).isMeshStandardMaterial
}

/** DCL scene GLBs often encode neon/HDR glow in baseColorFactor > 1 (Unity exports). */
function promoteHdrAlbedoToEmissive(mat: THREE.MeshStandardMaterial): void {
  const r = mat.color.r
  const g = mat.color.g
  const b = mat.color.b
  const hdrR = Math.max(0, r - 1)
  const hdrG = Math.max(0, g - 1)
  const hdrB = Math.max(0, b - 1)
  if (hdrR + hdrG + hdrB < 0.01) return

  mat.emissive.r += hdrR
  mat.emissive.g += hdrG
  mat.emissive.b += hdrB
  mat.color.setRGB(Math.min(r, 1), Math.min(g, 1), Math.min(b, 1))
}

/**
 * Scene GLTF emissive parity — wearables already get Forge-style boost via applyWearableEmissives;
 * baked scene models need the same pass plus HDR albedo promotion from glTF baseColorFactor.
 */
export function applySceneGltfEmissives(root: THREE.Object3D): void {
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    const materials = Array.isArray(obj.material) ? obj.material : [obj.material]
    for (const mat of materials) {
      if (!isStandardMaterial(mat)) continue
      promoteHdrAlbedoToEmissive(mat)
    }
  })
  applyWearableEmissives(root)
}