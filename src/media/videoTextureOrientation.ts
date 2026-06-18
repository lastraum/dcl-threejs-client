import * as THREE from 'three'

/**
 * Scene VideoTexture orientation for MeshRenderer planes.
 * DCL/Babylon VideoTexture uses invertY=false with SW/SE/NE/NW plane UVs.
 */
export function configureSceneVideoTexture(tex: THREE.Texture): void {
  tex.flipY = false
  tex.needsUpdate = true
}