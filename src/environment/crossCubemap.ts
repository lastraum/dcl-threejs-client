import * as THREE from 'three'

/** Horizontal cross layout: 4×3 faces (Unity StylizedSkybox import). */
const CROSS_FACE_LAYOUT: ReadonlyArray<{ x: number; y: number }> = [
  { x: 2, y: 1 }, // +X
  { x: 0, y: 1 }, // -X
  { x: 1, y: 0 }, // +Y
  { x: 1, y: 2 }, // -Y
  { x: 1, y: 1 }, // +Z
  { x: 3, y: 1 } // -Z
]

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
  const faceSize = img.width / 4
  if (faceSize * 3 !== img.height) {
    throw new Error(`Invalid cross cubemap layout: ${url} (${img.width}×${img.height})`)
  }

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
  cube.minFilter = THREE.LinearMipmapLinearFilter
  cube.magFilter = THREE.LinearFilter
  cube.generateMipmaps = true
  cube.anisotropy = 8
  cube.needsUpdate = true
  return cube
}
