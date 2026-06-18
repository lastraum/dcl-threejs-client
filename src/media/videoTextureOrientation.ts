import * as THREE from 'three'

/**
 * Scene VideoTexture orientation for MeshRenderer planes.
 * DCL/Babylon uses invertY=false with Babylon plane UVs (v=1 at mesh bottom).
 * Our planes use Three.js UVs (v=0 at bottom) — flipY must stay true.
 */
export function configureSceneVideoTexture(tex: THREE.Texture): void {
  tex.flipY = true
  tex.needsUpdate = true
}