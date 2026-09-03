/**
 * Off-thread GLB parse. GLTFLoader runs here only to decode buffers/Draco.
 * The worker graph is discarded after flatten — main inflates from transferable
 * typed arrays (no Array.from, no second parseAsync).
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { safeDecodeURIComponent } from '../util/safeDecodeURIComponent'
import { collectTransfers, flattenGltf, type XferGltfPayload } from '../rendering/gltfTransferable'
import { installFetchTextureHandler } from '../rendering/fetchImageTextureLoader'

type ParseRequest = {
  type: 'parse'
  id: number
  buffer: ArrayBuffer
  resourcePath: string
  urlMappings: Record<string, string>
}

type ParseDone = {
  type: 'parse-done'
  id: number
  payload: XferGltfPayload
}

type ParseError = { type: 'parse-error'; id: number; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

function leafName(url: string): string {
  const clean = url.split('?')[0]!.split('#')[0]!
  const parts = clean.split('/')
  return safeDecodeURIComponent(parts[parts.length - 1] ?? clean)
}

function mappingKeyVariants(key: string): string[] {
  const leaf = leafName(key)
  const variants = new Set<string>([
    key,
    leaf,
    safeDecodeURIComponent(key),
    key.toLowerCase(),
    leaf.toLowerCase(),
    safeDecodeURIComponent(key).toLowerCase()
  ])
  if (leaf.endsWith('.png.png')) {
    const single = leaf.slice(0, -4)
    variants.add(single)
    variants.add(single.toLowerCase())
  } else if (leaf.endsWith('.png')) {
    variants.add(`${leaf}.png`)
    variants.add(`${leaf}.png`.toLowerCase())
  }
  return [...variants]
}

function resolveMappedUrl(url: string, mappings: Record<string, string>): string {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url
  for (const variant of mappingKeyVariants(url)) {
    const hit = mappings[variant]
    if (hit) return hit
  }
  if (/\/content\/contents\/(bafy|bafkre|Qm)/i.test(url.split('?')[0] ?? url)) return url
  return url
}

function createLoader(urlMappings: Record<string, string>): GLTFLoader {
  const manager = new THREE.LoadingManager()
  manager.setURLModifier((url) => resolveMappedUrl(url, urlMappings))
  installFetchTextureHandler(manager)
  const draco = new DRACOLoader()
  draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
  const loader = new GLTFLoader(manager)
  loader.setDRACOLoader(draco)
  return loader
}

ctx.onmessage = (ev: MessageEvent<ParseRequest>) => {
  const msg = ev.data
  if (msg.type !== 'parse') return

  void createLoader(msg.urlMappings)
    .parseAsync(msg.buffer, msg.resourcePath)
    .then(async (gltf) => {
      const payload = await flattenGltf(gltf.scene, gltf.animations ?? [])
      const transfers = collectTransfers(payload)
      ctx.postMessage({ type: 'parse-done', id: msg.id, payload } satisfies ParseDone, transfers)
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      ctx.postMessage({ type: 'parse-error', id: msg.id, message } satisfies ParseError)
    })
}
