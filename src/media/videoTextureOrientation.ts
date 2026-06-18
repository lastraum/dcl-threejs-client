import * as THREE from 'three'

/**
 * Scene VideoTexture orientation for MeshRenderer planes (SW/SE/NE/NW UV layout).
 * flipY=true matches Three.js texture upload with our plane corner UVs.
 */
export function configureSceneVideoTexture(tex: THREE.Texture): void {
  tex.flipY = true
  tex.needsUpdate = true
}