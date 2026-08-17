import * as THREE from 'three'

/**
 * Scene video texture orientation.
 *
 * VideoTexture is **shared** (one decode, many screens). Never flipY / ST on
 * the texture to fix one mesh — that inverts every other consumer.
 *
 * - Texture `flipY` stays **false** at create (LiveKit / ThrottledVideoTexture).
 * - **glTF video** (GltfNodeModifiers): FrontSide + **geometry V** (1−v) only
 *   when the VideoTexture is bound. Do not DoubleSide, geometry-U-flip, or
 *   mutate UVs on the first unlit/black modifier pass.
 * - **MeshRenderer planes**: apply path may set flipY=true for that plane's UVs.
 */
export function configureSceneVideoTexture(tex: THREE.Texture, flipY = false): void {
  if (tex.flipY !== flipY) {
    tex.flipY = flipY
    tex.needsUpdate = true
  }
}