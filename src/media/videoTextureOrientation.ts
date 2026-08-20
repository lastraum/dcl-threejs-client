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

/** Chrome `texSubImage2D` throws "Overload resolution failed" on 0×0 video frames. */
export function videoElementIsDrawable(video: HTMLVideoElement | null | undefined): boolean {
  if (!video) return false
  return (
    video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA &&
    video.videoWidth > 0 &&
    video.videoHeight > 0
  )
}

/**
 * THREE.VideoTexture's rVFC always sets needsUpdate, even before the first
 * decoded frame (LiveKit / HLS attach). WebGL then uploads a 0×0 video and
 * Chrome throws `texSubImage2D: Overload resolution failed` — plaza screens
 * stay black. Gate needsUpdate on real dimensions.
 */
export function guardVideoTextureUploads(
  tex: THREE.VideoTexture,
  video: HTMLVideoElement
): void {
  const inner = tex as THREE.VideoTexture & { __dclUploadGuarded?: boolean }
  if (inner.__dclUploadGuarded) return
  inner.__dclUploadGuarded = true

  const protoUpdate = tex.update.bind(tex)
  tex.update = function updateGuarded(): void {
    if (!videoElementIsDrawable(video)) return
    protoUpdate()
  }

  let flag = tex.needsUpdate
  Object.defineProperty(tex, 'needsUpdate', {
    configurable: true,
    enumerable: true,
    get: () => flag,
    set: (next: boolean) => {
      flag = next === true && videoElementIsDrawable(video)
    }
  })
}