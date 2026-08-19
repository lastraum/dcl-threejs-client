import * as THREE from 'three'

/**
 * Horizontal cross layout: 4×3 faces.
 * Same slice Unity TextureImporter uses for StylizedSkybox (`textureShape: Cube`,
 * `generateCubemap: AutoCubemap`) on SkyboxFarClouds / Near / horizon / top.
 */
const CROSS_FACE_LAYOUT: ReadonlyArray<{ x: number; y: number }> = [
  { x: 2, y: 1 }, // +X
  { x: 0, y: 1 }, // -X
  { x: 1, y: 0 }, // +Y
  { x: 1, y: 2 }, // -Y
  { x: 1, y: 1 }, // +Z
  { x: 3, y: 1 } // -Z
]

/**
 * Unity WebGL platform override on those cubemaps: `maxTextureSize: 1024`.
 * Source PNGs are 8192×6144 (2048² faces). Sampling a 2048 face across the
 * whole sky without mips aliases as faint vertical hairlines.
 */
const UNITY_WEBGL_CUBE_FACE = 1024

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Failed to load cubemap source: ${url}`))
    img.src = url
  })
}

/** Build a Three.js cubemap from a 4-wide × 3-tall cross image (DCL sky assets). */
export async function loadCrossCubemap(url: string): Promise<THREE.CubeTexture> {
  const img = await loadImage(url)
  const srcFace = img.width / 4
  if (srcFace * 3 !== img.height) {
    throw new Error(`Invalid cross cubemap layout: ${url} (${img.width}×${img.height})`)
  }

  const faceSize = Math.min(srcFace, UNITY_WEBGL_CUBE_FACE)
  const canvas = document.createElement('canvas')
  canvas.width = faceSize
  canvas.height = faceSize
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas 2D unavailable')

  const faces = CROSS_FACE_LAYOUT.map(({ x, y }) => {
    ctx.clearRect(0, 0, faceSize, faceSize)
    ctx.drawImage(img, x * srcFace, y * srcFace, srcFace, srcFace, 0, 0, faceSize, faceSize)
    const faceCanvas = document.createElement('canvas')
    faceCanvas.width = faceSize
    faceCanvas.height = faceSize
    faceCanvas.getContext('2d')!.drawImage(canvas, 0, 0)
    return faceCanvas
  })

  const cube = new THREE.CubeTexture(faces)
  cube.colorSpace = THREE.SRGBColorSpace
  cube.wrapS = THREE.ClampToEdgeWrapping
  cube.wrapT = THREE.ClampToEdgeWrapping
  // Unity TextureImporter on these assets: enableMipMap=1, filterMode=Bilinear,
  // aniso=1, mipBias=0. WebGL2 cubemap filtering is seamless — mips are what
  // stop 2048² faces minifying into hairlines. Aniso>1 on cubes streaks.
  cube.generateMipmaps = true
  cube.minFilter = THREE.LinearMipmapLinearFilter
  cube.magFilter = THREE.LinearFilter
  cube.anisotropy = 1
  cube.needsUpdate = true
  return cube
}
