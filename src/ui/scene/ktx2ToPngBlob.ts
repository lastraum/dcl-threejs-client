import * as THREE from 'three'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'

/** KTX2 file magic: «KTX 20» */
export function isKtx2Bytes(bytes: Uint8Array): boolean {
  return (
    bytes.length >= 12 &&
    bytes[0] === 0xab &&
    bytes[1] === 0x4b &&
    bytes[2] === 0x54 &&
    bytes[3] === 0x58 &&
    bytes[4] === 0x20 &&
    bytes[5] === 0x32 &&
    bytes[6] === 0x30 &&
    bytes[7] === 0xbb
  )
}

let decoder: {
  loader: KTX2Loader
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.OrthographicCamera
  mesh: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>
} | null = null

function ensureDecoder(): NonNullable<typeof decoder> {
  if (decoder) return decoder
  const canvas = document.createElement('canvas')
  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    premultipliedAlpha: false,
    preserveDrawingBuffer: true,
    powerPreference: 'low-power',
    failIfMajorPerformanceCaveat: false
  })
  renderer.setClearColor(0x000000, 0)
  renderer.setSize(4, 4, false)
  const loader = new KTX2Loader()
  loader.setTranscoderPath('/basis/')
  loader.detectSupport(renderer)
  const scene = new THREE.Scene()
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
  // NoBlending + transparent: write atlas RGBA as-is. Opaque blit turned
  // rounded-card / icon transparent texels into black corners.
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 2),
    new THREE.MeshBasicMaterial({
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
      transparent: true,
      opacity: 1,
      blending: THREE.NoBlending
    })
  )
  scene.add(mesh)
  decoder = { loader, renderer, scene, camera, mesh }
  return decoder
}

/** Explorer MediaConverter returns KTX2 — blit to RGBA and emit a PNG blob for DOM <img>. */
export async function ktx2BytesToPngBlob(bytes: Uint8Array): Promise<Blob> {
  const { loader, renderer, scene, camera, mesh } = ensureDecoder()
  const copy = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  const ab = copy instanceof ArrayBuffer ? copy : Uint8Array.from(bytes).buffer
  const texture = await new Promise<THREE.Texture>((resolve, reject) => {
    loader.parse(ab, (tex) => resolve(tex), (err) => reject(err ?? new Error('KTX2 parse failed')))
  })
  const img = texture.image as { width?: number; height?: number } | undefined
  const w = img?.width ?? 0
  const h = img?.height ?? 0
  if (w < 1 || h < 1) {
    texture.dispose()
    throw new Error('KTX2 has no size')
  }

  mesh.material.map = texture
  mesh.material.transparent = true
  mesh.material.blending = THREE.NoBlending
  mesh.material.needsUpdate = true
  const rt = new THREE.WebGLRenderTarget(w, h, {
    format: THREE.RGBAFormat,
    type: THREE.UnsignedByteType,
    colorSpace: THREE.SRGBColorSpace
  })
  const prev = renderer.getRenderTarget()
  renderer.setClearColor(0x000000, 0)
  renderer.setSize(w, h, false)
  renderer.setRenderTarget(rt)
  renderer.clear()
  renderer.render(scene, camera)
  const pixels = new Uint8Array(w * h * 4)
  renderer.readRenderTargetPixels(rt, 0, 0, w, h, pixels)
  renderer.setRenderTarget(prev)
  rt.dispose()
  mesh.material.map = null
  texture.dispose()

  // WebGL origin is bottom-left — flip for canvas.
  const flipped = new Uint8ClampedArray(w * h * 4)
  const row = w * 4
  for (let y = 0; y < h; y++) {
    flipped.set(pixels.subarray((h - 1 - y) * row, (h - y) * row), y * row)
  }
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('no 2d')
  ctx.putImageData(new ImageData(flipped, w, h), 0, 0)
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
  return blob
}
