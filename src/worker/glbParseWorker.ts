/**
 * Offloads GLTF Draco parse from the main thread. Returns a structured-cloneable
 * THREE.Group + animation clips for AssetCache to cache on main.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
// Worker path is experimental — THREE graphs are not structured-cloneable (see gltfWorkerTransfer.ts).

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
  scene: THREE.Group
  animations: THREE.AnimationClip[]
}

type ParseError = { type: 'parse-error'; id: number; message: string }

const ctx = self as unknown as DedicatedWorkerGlobalScope

function leafName(url: string): string {
  const clean = url.split('?')[0]!.split('#')[0]!
  const parts = clean.split('/')
  return decodeURIComponent(parts[parts.length - 1] ?? clean)
}

function mappingKeyVariants(key: string): string[] {
  const leaf = leafName(key)
  const variants = new Set<string>([
    key,
    leaf,
    decodeURIComponent(key),
    key.toLowerCase(),
    leaf.toLowerCase(),
    decodeURIComponent(key).toLowerCase()
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
    .then((gltf) => {
      const payload = {
        type: 'parse-done',
        id: msg.id,
        scene: gltf.scene,
        animations: gltf.animations ?? []
      } satisfies ParseDone
      try {
        structuredClone(payload)
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'GLB parse result is not structured-cloneable'
        ctx.postMessage({ type: 'parse-error', id: msg.id, message } satisfies ParseError)
        return
      }
      ctx.postMessage(payload)
    })
    .catch((err) => {
      const message = err instanceof Error ? err.message : String(err)
      ctx.postMessage({ type: 'parse-error', id: msg.id, message } satisfies ParseError)
    })
}
