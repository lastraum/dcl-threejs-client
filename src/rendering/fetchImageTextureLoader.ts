import * as THREE from 'three'
import {
  guessImageMimeFromBytes,
  guessImageMimeFromUrl,
  proxiedTextureUrl
} from './textureProxy'

/**
 * GLTFLoader uses TextureLoader/ImageBitmapLoader via LoadingManager.getHandler(uri).
 * Catalyst `/contents/<hash>` is often `application/octet-stream` + nosniff, so
 * `Image(src=url)` fails on Safari and the parse caches a beige mesh until reload.
 * Fetch bytes, stamp a real image MIME, then decode.
 */
export class FetchImageTextureLoader extends THREE.Loader {
  load(
    url: string,
    onLoad?: (texture: THREE.Texture) => void,
    _onProgress?: (event: ProgressEvent) => void,
    onError?: (err: unknown) => void
  ): THREE.Texture {
    const texture = new THREE.Texture()
    const resolved = proxiedTextureUrl(this.manager.resolveURL(url))
    this.manager.itemStart(resolved)
    void decodeFetchedImage(resolved)
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

export function installFetchTextureHandler(manager: THREE.LoadingManager): void {
  const loader = new FetchImageTextureLoader(manager)
  manager.addHandler(/\.(png|jpe?g|webp|gif|bmp|avif)(\?|#|$)/i, loader)
  manager.addHandler(/\/contents\//i, loader)
}

export async function decodeFetchedImage(url: string): Promise<HTMLImageElement | ImageBitmap> {
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
    (headerType.startsWith('image/') ? headerType : null) ??
    'image/png'
  const blob = new Blob([buffer], { type: mime })
  if (typeof Image === 'undefined') {
    return createImageBitmap(blob)
  }
  return loadImageFromBlob(blob)
}

/** Keep the blob URL until WebGL has sampled it. Revoke-on-0 left white maps on some GPUs. */
export function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const finish = (): void => resolve(img)
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
    ;(img as HTMLImageElement & { _dclBlobUrl?: string })._dclBlobUrl = objectUrl
    img.src = objectUrl
  })
}

export function revokeTextureBlobUrl(texture: THREE.Texture): void {
  const image = texture.image as { _dclBlobUrl?: string } | undefined
  const blobUrl = image?._dclBlobUrl
  if (!blobUrl) return
  image._dclBlobUrl = undefined
  try {
    URL.revokeObjectURL(blobUrl)
  } catch {
    /* already revoked */
  }
}
