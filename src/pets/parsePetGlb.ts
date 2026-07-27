/**
 * Parse pet GLB with embedded images rewritten as data URIs.
 *
 * GLTFLoader turns bufferView images into blob: URLs; under Vite those often fail
 * (`Couldn't load texture blob:http://localhost:…`), leaving blotchy/white materials.
 *
 * We:
 * 1. Extract image bufferViews → data:image/…;base64,…
 * 2. Rebuild a valid GLB (JSON + original BIN for mesh accessors)
 * 3. parseAsync the rebuilt GLB — geometry uses BIN, textures use data URIs (no blob:)
 */
import * as THREE from 'three'
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'

const GLB_MAGIC = 0x46546c67 // glTF
const CHUNK_JSON = 0x4e4f534a // JSON
const CHUNK_BIN = 0x004e4942 // BIN\0

const loader = new GLTFLoader()

function u32(view: DataView, offset: number): number {
  return view.getUint32(offset, true)
}

function writeU32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value, true)
}

function bytesToBase64(bytes: Uint8Array): string {
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length))
    binary += String.fromCharCode(...slice)
  }
  return btoa(binary)
}

function pad4(n: number): number {
  return (n + 3) & ~3
}

/** Rebuild GLB bytes from JSON object + BIN chunk (4-byte aligned). */
function rebuildGlb(json: Record<string, unknown>, bin: Uint8Array): ArrayBuffer {
  const jsonText = JSON.stringify(json)
  const jsonBytes = new TextEncoder().encode(jsonText)
  const jsonPad = pad4(jsonBytes.length) - jsonBytes.length
  const binPad = pad4(bin.length) - bin.length

  const total =
    12 + // header
    8 +
    jsonBytes.length +
    jsonPad + // JSON chunk
    8 +
    bin.length +
    binPad // BIN chunk

  const out = new ArrayBuffer(total)
  const view = new DataView(out)
  const u8 = new Uint8Array(out)

  writeU32(view, 0, GLB_MAGIC)
  writeU32(view, 4, 2) // version
  writeU32(view, 8, total)

  let o = 12
  writeU32(view, o, jsonBytes.length + jsonPad)
  writeU32(view, o + 4, CHUNK_JSON)
  u8.set(jsonBytes, o + 8)
  // glTF JSON chunk pad must be 0x20 spaces (not 0x00) — null pad makes GLTFLoader
  // JSON.parse throw "Unexpected non-whitespace character after JSON".
  for (let i = 0; i < jsonPad; i++) u8[o + 8 + jsonBytes.length + i] = 0x20
  o += 8 + jsonBytes.length + jsonPad

  writeU32(view, o, bin.length + binPad)
  writeU32(view, o + 4, CHUNK_BIN)
  u8.set(bin, o + 8)

  return out
}

/**
 * Parse pet model bytes. Prefers data-URI image rewrite + GLB rebuild.
 */
export async function parsePetGlbBytes(bytes: ArrayBuffer): Promise<GLTF> {
  const copy = bytes.slice(0)
  if (copy.byteLength < 20) {
    return loader.parseAsync(copy, '')
  }
  const view = new DataView(copy)
  if (u32(view, 0) !== GLB_MAGIC) {
    return loader.parseAsync(copy, '')
  }

  try {
    let offset = 12
    let json: Record<string, unknown> | null = null
    let bin: Uint8Array | null = null

    while (offset + 8 <= copy.byteLength) {
      const chunkLen = u32(view, offset)
      const chunkType = u32(view, offset + 4)
      const chunkStart = offset + 8
      const chunkEnd = chunkStart + chunkLen
      if (chunkEnd > copy.byteLength) break
      if (chunkType === CHUNK_JSON) {
        // JSON chunk may include trailing spaces for 4-byte pad
        let text = new TextDecoder().decode(new Uint8Array(copy, chunkStart, chunkLen))
        text = text.replace(/\0+$/, '').trimEnd()
        json = JSON.parse(text) as Record<string, unknown>
      } else if (chunkType === CHUNK_BIN) {
        // Copy BIN so it outlives the source buffer independently
        bin = new Uint8Array(chunkLen)
        bin.set(new Uint8Array(copy, chunkStart, chunkLen))
      }
      offset = chunkEnd
    }

    if (!json || !bin) {
      return loader.parseAsync(copy, '')
    }

    // Ensure buffers[0] describes the BIN without external URI (GLB embedded).
    const buffers = (json.buffers as Array<Record<string, unknown>> | undefined) ?? []
    if (buffers[0]) {
      buffers[0].byteLength = bin.length
      delete buffers[0].uri
    } else {
      json.buffers = [{ byteLength: bin.length }]
    }

    const images = json.images as Array<Record<string, unknown>> | undefined
    const bufferViews = json.bufferViews as Array<Record<string, unknown>> | undefined
    let rewritten = 0
    if (images?.length && bufferViews?.length) {
      for (const image of images) {
        if (typeof image.uri === 'string' && image.uri.length > 0) continue
        const bvIndex = image.bufferView
        if (typeof bvIndex !== 'number' || bvIndex < 0 || bvIndex >= bufferViews.length) continue
        const bv = bufferViews[bvIndex]!
        const byteOffset = typeof bv.byteOffset === 'number' ? bv.byteOffset : 0
        const byteLength = typeof bv.byteLength === 'number' ? bv.byteLength : 0
        if (byteLength <= 0 || byteOffset + byteLength > bin.length) continue
        const slice = bin.subarray(byteOffset, byteOffset + byteLength)
        const mime =
          typeof image.mimeType === 'string' && image.mimeType.startsWith('image/')
            ? image.mimeType
            : 'image/png'
        image.uri = `data:${mime};base64,${bytesToBase64(slice)}`
        delete image.bufferView
        delete image.mimeType
        rewritten++
      }
    }

    if (rewritten === 0) {
      // No embedded images to rewrite — stock GLB parse is fine.
      return loader.parseAsync(copy, '')
    }

    const rebuilt = rebuildGlb(json, bin)
    const gltf = await loader.parseAsync(rebuilt, '')
    return gltf
  } catch (err) {
    console.warn('[pets] data-uri GLB rewrite failed — falling back to parseAsync', err)
    return loader.parseAsync(copy, '')
  }
}

/** Debug helper — count textures that actually have map data after parse. */
export function countMappedMaterials(root: THREE.Object3D): { meshes: number; withMap: number } {
  let meshes = 0
  let withMap = 0
  root.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh || !mesh.material) return
    meshes++
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    if (mats.some((m) => m && 'map' in m && (m as THREE.MeshStandardMaterial).map)) withMap++
  })
  return { meshes, withMap }
}
