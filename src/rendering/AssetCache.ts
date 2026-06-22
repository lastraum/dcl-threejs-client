import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { clearSceneContent, configureSceneContent, popEmoteContent, popWearableMappings, pushEmoteContent, pushWearableMappings, resolveDclAssetUrl } from './DclTextureResolver'
import type { ResolvedScene } from '../dcl/content/types'
import type { ContentFile } from '../dcl/content/types'
import { buildParseUrlMappings } from './DclTextureResolver'
import {
  sanitizeSceneGltfColliders,
  sanitizeSceneGltfMaterials
} from './LandscapeAssetSanitizer'
import { applySceneGltfEmissives } from './sceneGltfEmissives'
import { deleteGlbBytes, normalizeGlbCacheKey, readGlbBytes } from './glbByteCache'
import { fetchGlbBytesOffThread, disposeGlbFetchPool } from './glbFetchPool'
import { parseGlbOffThread, disposeGlbParsePool } from './glbParsePool'
import { isGlbOffThreadParseEnabled } from './gltfWorkerTransfer'
import { prepareGlbBytes } from './glbSanitizer'
import { markSharedAssetResources } from './sharedAsset'
import { cloneGltfInstance } from './skinnedMeshInstance'
import { prepareAvatarMaterials } from '../avatar/materials'
import { prepareWearableCacheRoot } from '../avatar/wearableCache'
import { clearLocomotionClipCache } from '../avatar/locomotionClipCache'

export type CachedGltf = {
  root: THREE.Group
  animations: THREE.AnimationClip[]
}

export type AssetLoadStats = {
  gltfInflight: number
  gltfCached: number
  textureInflight: number
  textureCached: number
}

/** One cache per browser tab — survives parcel/world teleports within a session. */
let sessionCache: AssetCache | null = null

export function getSessionAssetCache(): AssetCache {
  if (!sessionCache) sessionCache = new AssetCache()
  return sessionCache
}

/** Full teardown on sign-out; evicts all parsed GLBs/textures from memory. */
export function disposeSessionAssetCache(): void {
  sessionCache?.dispose()
  sessionCache = null
  clearLocomotionClipCache()
  disposeGlbFetchPool()
  disposeGlbParsePool()
}

const prefetchedSceneIds = new Set<string>()

/** Start byte-only fetches for every `.glb` in the scene manifest — safe to call multiple times. */
export function prefetchSceneManifestGlbs(cache: AssetCache, scene: ResolvedScene): void {
  const sceneKey = scene.entityId ?? scene.title
  if (sceneKey && prefetchedSceneIds.has(sceneKey)) return

  const urls: Array<{ url: string; hash: string }> = []
  const seen = new Set<string>()

  for (const entry of scene.content) {
    if (!entry.file.toLowerCase().endsWith('.glb')) continue
    if (!entry.hash || seen.has(entry.hash)) continue
    seen.add(entry.hash)
    urls.push({ url: scene.assetUrl(entry.hash), hash: entry.hash })
  }

  if (urls.length) {
    if (sceneKey) prefetchedSceneIds.add(sceneKey)
    console.info(`[assets] prefetching ${urls.length} scene GLB(s) (bytes only, parallel)`)
    cache.prefetchAll(urls)
  }
}

/**
 * GLB pipeline (one consumer path):
 * 1. `prefetchAll` / manifest — bytes only (worker pool + IndexedDB), no parse.
 * 2. `load` / `clone` — IDB → in-flight bytes → network → parse → `cache`.
 * Warm revisits hit step 2 immediately; cold loads reuse step 1 bytes in step 2.
 */
export class AssetCache {
  private loader: GLTFLoader
  private textureLoader: THREE.TextureLoader
  private cache = new Map<string, CachedGltf>()
  private inflight = new Map<string, Promise<CachedGltf>>()
  /** Raw byte prefetch (network/IDB only) — consumed by `load` via `resolveGlbBytes`. */
  private bytesInflight = new Map<string, Promise<ArrayBuffer>>()
  private textures = new Map<string, THREE.Texture>()
  private textureInflight = new Map<string, Promise<THREE.Texture>>()
  private warnedFailed = new Set<string>()
  private failedUntil = new Map<string, number>()
  private failCount = new Map<string, number>()
  private givenUp = new Set<string>()

  private static readonly FAILED_RETRY_MS = 2_000
  private static readonly MAX_LOAD_ATTEMPTS = 5

  constructor() {
    const manager = new THREE.LoadingManager()
    manager.setURLModifier((url) => resolveDclAssetUrl(url))

    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    this.loader = new GLTFLoader(manager)
    this.loader.setDRACOLoader(draco)
    this.textureLoader = new THREE.TextureLoader(manager)
  }

  /** Wire scene content manifest into the global glTF URL rewriter. */
  setScene(scene: ResolvedScene): void {
    configureSceneContent(scene.content, scene.assetUrl, scene.entityId)
  }

  clearScene(): void {
    clearSceneContent()
  }

  /**
   * Release cached GLBs/textures. Only call from `disposeSessionAssetCache` on sign-out —
   * parcel navigation keeps the session cache alive and only clears the scene manifest.
   */
  dispose(): void {
    for (const entry of this.cache.values()) {
      disposeCachedRoot(entry.root)
    }
    this.cache.clear()
    this.inflight.clear()
    this.bytesInflight.clear()

    for (const texture of this.textures.values()) {
      texture.dispose()
    }
    this.textures.clear()
    this.textureInflight.clear()
    clearSceneContent()
  }

  getLoadStats(): AssetLoadStats {
    return {
      gltfInflight: this.inflight.size + this.bytesInflight.size,
      gltfCached: this.cache.size,
      textureInflight: this.textureInflight.size,
      textureCached: this.textures.size
    }
  }

  hasCached(key: string): boolean {
    return this.cache.has(key)
  }

  /** True when bytes or parse is in flight — used to prioritize attach passes. */
  isResolving(key: string): boolean {
    return this.inflight.has(key) || this.bytesInflight.has(key)
  }

  hasGivenUp(key: string): boolean {
    return this.givenUp.has(key)
  }

  hasPendingLoads(): boolean {
    return this.inflight.size > 0 || this.bytesInflight.size > 0 || this.textureInflight.size > 0
  }

  async preload(urls: Array<{ url: string; hash?: string }>): Promise<void> {
    await Promise.all(urls.map(({ url, hash }) => this.load(url, hash)))
  }

  /** Fire off network/IDB byte fetches for all hashes without parsing. Does not block. */
  prefetchAll(urls: Array<{ url: string; hash?: string }>): void {
    for (const { url, hash } of urls) {
      this.prefetchBytes(url, hash)
    }
  }

  /** Download GLB bytes only — keeps main thread free for hydration attach + PhysX. */
  prefetchBytes(url: string, hash?: string): void {
    const key = normalizeGlbCacheKey(hash ?? url)
    if (
      this.cache.has(key) ||
      this.inflight.has(key) ||
      this.bytesInflight.has(key) ||
      this.givenUp.has(key)
    ) {
      return
    }
    const retryAt = this.failedUntil.get(key) ?? 0
    if (performance.now() < retryAt) return

    const task = fetchGlbBytesOffThread(url, key)
      .then((buffer) => buffer.slice(0))
      .finally(() => {
        this.bytesInflight.delete(key)
      })

    this.bytesInflight.set(key, task)
    void task.catch(() => {})
  }

  async preloadTextures(urls: string[]): Promise<void> {
    await Promise.all(urls.map((url) => this.textureLoader.loadAsync(url)))
  }

  async load(url: string, hash?: string, options?: { emote?: boolean; wearable?: boolean; quiet?: boolean }): Promise<CachedGltf> {
    const key = normalizeGlbCacheKey(hash ?? url)
    const hit = this.cache.get(key)
    if (hit) return hit

    const pending = this.inflight.get(key)
    if (pending) return pending

    const task = this.loadFromDbOrNetwork(url, key, options)
      .then((entry) => {
        markSharedAssetResources(entry.root)
        this.cache.set(key, entry)
        this.inflight.delete(key)
        this.failedUntil.delete(key)
        this.failCount.delete(key)
        this.givenUp.delete(key)
        return entry
      })
      .catch((err) => {
        this.inflight.delete(key)
        const attempts = (this.failCount.get(key) ?? 0) + 1
        this.failCount.set(key, attempts)
        if (attempts >= AssetCache.MAX_LOAD_ATTEMPTS) {
          this.givenUp.add(key)
          this.failedUntil.delete(key)
        } else {
          this.failedUntil.set(key, performance.now() + AssetCache.FAILED_RETRY_MS)
        }
        if (!options?.quiet && !this.warnedFailed.has(key)) {
          this.warnedFailed.add(key)
          console.warn('[AssetCache] GLB load failed', url, err)
        }
        throw err
      })

    this.inflight.set(key, task)
    return task
  }

  private async loadFromDbOrNetwork(
    url: string,
    key: string,
    options?: { emote?: boolean; wearable?: boolean; quiet?: boolean }
  ): Promise<CachedGltf> {

    const gltf = await this.fetchAndParseGltf(url, key, options?.quiet)
    const entry: CachedGltf = {
      root: gltf.scene,
      animations: gltf.animations ?? []
    }
    if (options?.wearable) {
      sanitizeSceneGltfMaterials(entry.root)
      prepareAvatarMaterials(entry.root)
      prepareWearableCacheRoot(entry.root)
    } else if (!options?.emote) {
      sanitizeSceneGltfColliders(entry.root)
      sanitizeSceneGltfMaterials(entry.root)
      applySceneGltfEmissives(entry.root)
    } else {
      entry.root.traverse((obj) => {
        if (/collider/i.test(obj.name)) obj.visible = false
      })
    }
    return entry
  }

  /** Load wearable GLB with per-wearable texture mappings (untinted — tint after clone). */
  async loadWearable(
    url: string,
    mappings: Record<string, string>,
    hash?: string
  ): Promise<CachedGltf> {
    const shouldPush = Object.keys(mappings).length > 0
    if (shouldPush) pushWearableMappings(mappings)
    try {
      return await this.load(url, hash, { wearable: true, quiet: true })
    } finally {
      if (shouldPush) popWearableMappings()
    }
  }

  /** Clone a cached wearable for one avatar — skin/hair tinting runs on the instance. */
  async loadWearableClone(
    url: string,
    mappings: Record<string, string>,
    hash?: string
  ): Promise<THREE.Group> {
    const { root } = await this.loadWearable(url, mappings, hash)
    return cloneGltfInstance(root)
  }

  /** Load emote GLB with entity content manifest so bundled textures (particles, etc.) resolve. */
  async loadEmote(url: string, content: ContentFile[], peerUrl: string, hash?: string): Promise<CachedGltf> {
    const root = peerUrl.replace(/\/$/, '')
    const assetUrl = (h: string) => `${root}/content/contents/${encodeURIComponent(h)}`
    pushEmoteContent(content, assetUrl)
    try {
      return await this.load(url, hash, { emote: true, quiet: true })
    } finally {
      popEmoteContent()
    }
  }

  /**
   * Returns a scene-graph clone for a new entity. Geometries and materials stay shared
   * with the cached GLB (one GPU upload per hash) — separate draw calls per instance.
   */
  async clone(url: string, hash?: string): Promise<THREE.Group> {
    const { root } = await this.load(url, hash)
    return cloneGltfInstance(root)
  }

  private gltfResourcePath(url: string): string {
    const clean = url.split('?')[0]!.split('#')[0]!
    const slash = clean.lastIndexOf('/')
    return slash >= 0 ? `${clean.slice(0, slash + 1)}` : ''
  }

  private async fetchAndParseGltf(url: string, cacheKey: string, quiet?: boolean) {
    let buffer = await this.resolveGlbBytes(url, cacheKey, quiet)

    const resourcePath = this.gltfResourcePath(url)
    if (isGlbOffThreadParseEnabled()) {
      try {
        const parsed = await parseGlbOffThread(buffer, resourcePath, buildParseUrlMappings())
        return { scene: parsed.scene, animations: parsed.animations }
      } catch {
        // THREE graphs are not postMessage-safe — fall back silently.
      }
    }
    return this.loader.parseAsync(buffer, resourcePath)
  }

  private async resolveGlbBytes(url: string, cacheKey: string, quiet?: boolean): Promise<ArrayBuffer> {
    let buffer = await readGlbBytes(cacheKey)
    if (buffer) {
      const prepared = prepareGlbBytes(buffer)
      if (prepared) return prepared
      if (!quiet) {
        console.warn('[AssetCache] invalid GLB in IndexedDB — re-fetching', cacheKey.slice(0, 16))
      }
      void deleteGlbBytes(cacheKey)
      buffer = null
    }

    const bytesPending = this.bytesInflight.get(cacheKey)
    if (bytesPending) {
      try {
        return await bytesPending
      } catch {
        /* fall through to direct fetch */
      }
    }

    return fetchGlbBytesOffThread(url, cacheKey)
  }

  async loadTexture(url: string): Promise<THREE.Texture> {
    const hit = this.textures.get(url)
    if (hit) return hit

    const pending = this.textureInflight.get(url)
    if (pending) return pending

    const task = this.textureLoader
      .loadAsync(url)
      .then((tex) => {
        this.textures.set(url, tex)
        this.textureInflight.delete(url)
        return tex
      })
      .catch((err) => {
        this.textureInflight.delete(url)
        throw err
      })

    this.textureInflight.set(url, task)
    return task
  }
}

function disposeCachedRoot(root: THREE.Object3D): void {
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    node.geometry?.dispose()
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    for (const material of materials) {
      material?.dispose()
    }
  })
}
