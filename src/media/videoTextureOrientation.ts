import * as THREE from 'three'

/**
 * Scene video texture orientation.
 *
 * - **glTF / GltfNodeModifiers** (Creator Hub video screens): `flipY=false` — glTF UV space
 *   (V grows up). flipY=true makes the picture “calendar upside-down” on those planes.
 * - **MeshRenderer planes** (primitive UV layout): pass `flipY=true` to match our SW/SE/NE/NW corners.
 *
 * Default is `false` so the common Creator Hub screen path is correct.
 */
export function configureSceneVideoTexture(tex: THREE.Texture, flipY = false): void {
  if (tex.flipY !== flipY) {
    tex.flipY = flipY
    tex.needsUpdate = true
  }
}