import * as THREE from 'three'
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import {
  guessImageMimeFromBytes,
  guessImageMimeFromUrl,
  preferFetchTextureLoad,
  proxiedTextureUrl
} from './textureProxy'

/** glTF image URIs only — never `/contents/` (that also matches .bin / GLB hashes). */
const IMAGE_URI_RE = /\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i

function isAppleWebKit(): boolean {
  if (typeof navigator === 'undefined') return false
  return (
    /iPad|iPhone|iPod/i.test(navigator.userAgent) ||
    ((navigator.maxTouchPoints ?? 0) > 1 && /Mac/i.test(navigator.platform || ''))
  )
}

function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const finish = (): void => {
        // WebKit uploads on a later frame — revoke-on-0 left white maps.
        if (!isAppleWebKit()) setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
        resolve(img)
      }
      if (typeof img.decode === 'function') {
        void img.decode().then(finish, finish)
        return
      }
      finish()
    }
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl)
      reject(new Error('image decode failed'))
    }
    img.src = objectUrl
  })
}

function loadImageElement(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error(`Image() failed: ${url}`))
    img.src = url
  })
}

/**
 * Fetch bytes, stamp a real image MIME, decode to HTMLImageElement.
 * Throws if the body is not an image — never default to image/png on a .bin.
 */
async function fetchAndDecodeImage(url: string): Promise<HTMLImageElement> {
  const res = await fetch(url, { redirect: 'follow', credentials: 'omit' })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const buffer = await res.arrayBuffer()
  if (!buffer.byteLength) throw new Error('empty texture response')
  const headerType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim()
  const generic =
    !headerType ||
    headerType === 'application/octet-stream' ||
    headerType === 'binary/octet-stream' ||
    headerType === 'application/binary' ||
    !headerType.startsWith('image/')
  const mime =
    (generic ? guessImageMimeFromUrl(url) : null) ??
    (generic ? guessImageMimeFromBytes(buffer) : null) ??
    (headerType.startsWith('image/') ? headerType : null)
  if (!mime) throw new Error(`not an image (${headerType || 'no content-type'})`)
  return loadImageFromBlob(new Blob([buffer], { type: mime }))
}

async function decodeSidecarImage(url: string): Promise<HTMLImageElement> {
  try {
    return await fetchAndDecodeImage(url)
  } catch {
    return loadImageElement(url)
  }
}

/** TextureLoader-shaped loader for GLTFParser.loadTextureImage. */
class GltfSidecarTextureLoader extends THREE.Loader {
  load(
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    _onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void
  ): THREE.Texture {
    const texture = new THREE.Texture()
    const resolved = proxiedTextureUrl(this.manager.resolveURL(url))
    this.manager.itemStart(resolved)
    void decodeSidecarImage(resolved)
      .then((image) => {
        texture.image = image
        texture.needsUpdate = true
        onLoad?.(texture)
        this.manager.itemEnd(resolved)
      })
      .catch((err) => {
        this.manager.itemError(resolved)
        this.manager.itemEnd(resolved)
        onError?.(err)
      })
    return texture
  }
}

/**
 * Intercept glTF image filenames (*.png etc.) on the main-thread LoadingManager.
 * GLTFLoader only asks getHandler() for image source URIs — FileLoader still
 * fetches buffers. Do not add a /contents/ handler.
 */
export function installGltfSidecarTextureHandler(manager: THREE.LoadingManager): void {
  manager.addHandler(IMAGE_URI_RE, new GltfSidecarTextureLoader(manager))
}

type GltfParserLike = {
  json: {
    textures?: Array<{ source?: number; extensions?: Record<string, unknown> }>
    images?: Array<{ uri?: string; bufferView?: number }>
  }
  options: { manager: THREE.LoadingManager }
  loadTextureImage: (
    textureIndex: number,
    sourceIndex: number,
    loader: THREE.Loader
  ) => Promise<THREE.Texture | null>
}

/**
 * Extensionless catalyst hashes (`/contents/bafy…`) never match IMAGE_URI_RE.
 * Hook only those, and only when preferFetch says Image() will refuse.
 * Leave KTX2 / Basis / embedded bufferViews to Three.
 */
export function registerGltfSidecarTexturePlugin(loader: GLTFLoader): void {
  loader.register((rawParser) => {
    const parser = rawParser as unknown as GltfParserLike
    return {
    name: 'DCL_gltf_sidecar_fetch',
    loadTexture(textureIndex: number) {
      const textureDef = parser.json.textures?.[textureIndex]
      if (!textureDef) return null
      const ext = textureDef.extensions
      if (
        ext &&
        (ext.KHR_texture_basisu || ext.EXT_texture_webp || ext.EXT_texture_avif)
      ) {
        return null
      }
      const sourceIndex = textureDef.source
      if (sourceIndex === undefined) return null
      const sourceDef = parser.json.images?.[sourceIndex]
      if (!sourceDef || sourceDef.bufferView !== undefined) return null
      const uri = sourceDef.uri
      if (!uri || uri.startsWith('data:') || uri.startsWith('blob:')) return null
      if (IMAGE_URI_RE.test(uri)) return null
      const resolved = parser.options.manager.resolveURL(uri)
      if (!preferFetchTextureLoad(resolved)) return null
      return parser.loadTextureImage(
        textureIndex,
        sourceIndex,
        new GltfSidecarTextureLoader(parser.options.manager)
      ).then((tex) => {
        if (!tex) throw new Error('sidecar texture failed')
        return tex
      })
    }
  }})
}
