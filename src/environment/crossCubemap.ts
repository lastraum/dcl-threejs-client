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
 * Unity WebGL platform override + scene map cap: never decode or upload a cube
 * face larger than 1024. Cross PNG is 4×3, so that is 4096×3072 source.
 */
const UNITY_WEBGL_CUBE_FACE = 1024

function pngIhdrSize(buffer: ArrayBuffer): { width: number; height: number } | null {
  if (buffer.byteLength < 24) return null
  const view = new DataView(buffer)
  if (view.getUint32(0) !== 0x89504e47 || view.getUint32(4) !== 0x0d0a1a0a) return null
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

/** Build a Three.js cubemap from a 4-wide × 3-tall cross image (DCL sky assets). */
export async function loadCrossCubemap(url: string): Promise<THREE.CubeTexture> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Failed to load cubemap source: ${url} (HTTP ${res.status})`)
  const buffer = await res.arrayBuffer()
  const header = pngIhdrSize(buffer)
  if (header && (header.width / 4) * 3 !== header.height) {
    throw new Error(`Invalid cross cubemap layout: ${url} (${header.width}×${header.height})`)
  }

  const srcFace = header ? header.width / 4 : UNITY_WEBGL_CUBE_FACE
  const faceSize = Math.min(srcFace, UNITY_WEBGL_CUBE_FACE)
  const blob = new Blob([buffer], { type: 'image/png' })
  const img = await createImageBitmap(blob, {
    resizeWidth: faceSize * 4,
    resizeHeight: faceSize * 3,
    resizeQuality: 'high'
  })

  try {
    const canvas = document.createElement('canvas')
    canvas.width = faceSize
    canvas.height = faceSize
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D unavailable')

    const faces = CROSS_FACE_LAYOUT.map(({ x, y }) => {
      ctx.clearRect(0, 0, faceSize, faceSize)
      ctx.drawImage(img, x * faceSize, y * faceSize, faceSize, faceSize, 0, 0, faceSize, faceSize)
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
    cube.generateMipmaps = true
    cube.minFilter = THREE.LinearMipmapLinearFilter
    cube.magFilter = THREE.LinearFilter
    cube.anisotropy = 1
    cube.needsUpdate = true
    return cube
  } finally {
    img.close()
  }
}
