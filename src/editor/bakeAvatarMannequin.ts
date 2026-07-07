import * as THREE from 'three'

export type BakedAvatarMannequinPart = {
  geometry: THREE.BufferGeometry
  material: THREE.Material
}

const _vertex = new THREE.Vector3()

function resolveMaterial(mat: THREE.Material | THREE.Material[]): THREE.Material {
  return Array.isArray(mat) ? mat[0]! : mat
}

/** Bake each skinned wearable mesh into static geometry at bind pose (instancing-friendly). */
export function bakeStaticMannequinFromRoot(avatarRoot: THREE.Object3D): BakedAvatarMannequinPart[] | null {
  avatarRoot.updateMatrixWorld(true)
  const rootWorld = avatarRoot.matrixWorld.clone()
  const rootInv = rootWorld.clone().invert()

  const parts: BakedAvatarMannequinPart[] = []

  avatarRoot.traverse((obj) => {
    if (!(obj instanceof THREE.SkinnedMesh)) return
    obj.skeleton.pose()
    obj.updateMatrixWorld(true)

    const baked = obj.geometry.clone()
    const pos = baked.attributes.position as THREE.BufferAttribute
    for (let i = 0; i < pos.count; i++) {
      obj.getVertexPosition(i, _vertex)
      _vertex.applyMatrix4(obj.matrixWorld).applyMatrix4(rootInv)
      pos.setXYZ(i, _vertex.x, _vertex.y, _vertex.z)
    }
    baked.computeVertexNormals()

    const sourceMaterial = resolveMaterial(obj.material)
    parts.push({ geometry: baked, material: sourceMaterial })
  })

  if (parts.length === 0) return null

  let minY = Infinity
  for (const part of parts) {
    part.geometry.computeBoundingBox()
    minY = Math.min(minY, part.geometry.boundingBox?.min.y ?? 0)
  }

  for (const part of parts) {
    part.geometry.translate(0, -minY, 0)
    part.geometry.computeBoundingBox()

    const material = part.material.clone()
    material.transparent = true
    material.opacity = 0.88
    material.depthWrite = false
    part.material = material
  }

  return parts
}