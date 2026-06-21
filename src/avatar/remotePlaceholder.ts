import * as THREE from 'three'

/** Lightweight stand-in while the full Catalyst profile compose runs. */
export function createRemoteAvatarPlaceholder(showPill = true): THREE.Group {
  const root = new THREE.Group()
  root.name = 'remote-placeholder'

  if (showPill) {
    const mesh = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.22, 0.85, 6, 10),
      new THREE.MeshStandardMaterial({
        color: 0x9aa3b0,
        transparent: true,
        opacity: 0.55,
        metalness: 0,
        roughness: 0.85,
        depthWrite: false
      })
    )
    mesh.position.y = 0.95
    mesh.castShadow = false
    mesh.receiveShadow = false
    root.add(mesh)
  }

  return root
}