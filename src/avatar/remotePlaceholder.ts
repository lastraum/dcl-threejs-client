import * as THREE from 'three'

/**
 * Shared GPU resources for remote loading stand-ins.
 * Each peer gets its own Mesh (own transform) but one CapsuleGeometry + one material
 * across the whole scene — N peers ≈ 1 geo/mat, not N×.
 * (InstancedMesh is a poor fit: each placeholder is parented under a different peer root.)
 */
let sharedCapsuleGeo: THREE.CapsuleGeometry | null = null
let sharedCapsuleMat: THREE.MeshStandardMaterial | null = null

/**
 * Visual stand-in ~1.88 m tall (matches PhysX CCT / DCL body scale).
 * CapsuleGeometry length = cylinder only; total height ≈ length + 2×radius.
 */
function getSharedCapsuleGeometry(): THREE.CapsuleGeometry {
  if (!sharedCapsuleGeo) {
    // radius 0.28, cylinder 1.32 → total ≈ 1.88 m
    sharedCapsuleGeo = new THREE.CapsuleGeometry(0.28, 1.32, 6, 10)
  }
  return sharedCapsuleGeo
}

function getSharedCapsuleMaterial(): THREE.MeshStandardMaterial {
  if (!sharedCapsuleMat) {
    sharedCapsuleMat = new THREE.MeshStandardMaterial({
      color: 0x9aa3b0,
      transparent: true,
      opacity: 0.55,
      metalness: 0,
      roughness: 0.85,
      depthWrite: false
    })
  }
  return sharedCapsuleMat
}

/** Lightweight stand-in while the full Catalyst / custom avatar compose runs. */
export function createRemoteAvatarPlaceholder(showPill = true): THREE.Group {
  const root = new THREE.Group()
  root.name = 'remote-placeholder'
  // Mark so dispose skips shared geo/mat.
  root.userData.remotePlaceholder = true

  if (showPill) {
    const mesh = new THREE.Mesh(getSharedCapsuleGeometry(), getSharedCapsuleMaterial())
    mesh.name = 'remote-placeholder-body'
    // Center of capsule at half height (feet at y=0).
    mesh.position.y = 0.94
    mesh.castShadow = false
    mesh.receiveShadow = false
    // Do not dispose shared resources when the mesh is removed.
    mesh.userData.sharedGpu = true
    root.add(mesh)
  }

  return root
}

/**
 * Detach a placeholder without disposing shared CapsuleGeometry / material.
 * Only removes the group from the scene graph.
 */
export function disposeRemoteAvatarPlaceholder(root: THREE.Object3D): void {
  root.removeFromParent()
  // Drop mesh children refs only — do NOT geometry.dispose() / material.dispose()
  // (those are process-lifetime shared resources).
  while (root.children.length > 0) {
    root.remove(root.children[0]!)
  }
}
