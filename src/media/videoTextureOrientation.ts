import * as THREE from 'three'

/**
 * Scene VideoTexture orientation for MeshRenderer planes.
 * DCL plane geometry uses the same corner UV layout as static textures (LL/LR/UR/UL).
 * flipY=true matches TextureLoader parity on those UVs.
 */
export function configureSceneVideoTexture(tex: THREE.Texture): void {
  tex.flipY = true
  tex.needsUpdate = true
}