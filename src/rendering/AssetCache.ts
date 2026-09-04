import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js'
import { clearSceneContent, configureSceneContent, popEmoteContent, popWearableMappings, pushEmoteContent, pushWearableMappings, resolveDclAssetUrl, unregisterSceneContent } from './DclTextureResolver'
import type { ResolvedScene } from '../dcl/content/types'
import type { ContentFile } from '../dcl/content/types'
import { buildParseUrlMappings } from './DclTextureResolver'
import {
  enableSceneGltfVertexColors,
  retuneScenePlantCutoutMaterials,
  sanitizeLandscapeGltf,
  sanitizeSceneGltfColliders,
  sanitizeSceneGltfMaterials
} from './LandscapeAssetSanitizer'
import { applySceneGltfEmissives } from './sceneGltfEmissives'
import { bindGltfWaterSurface } from './gltfWaterSurface'
import { deleteGlbBytes, normalizeGlbCacheKey, readGlbBytes } from './glbByteCache'
import { fetchGlbBytesOffThread, disposeGlbFetchPool } from './glbFetchPool'
import { parseGlbOffThread, disposeGlbParsePool } from './glbParsePool'
import { isGlbOffThreadParseEnabled } from './gltfWorkerTransfer'
import { flattenGltf, inflateGltf } from './gltfTransferable'
import { prepareGlbBytes } from './glbSanitizer'
import { clampObject3DTextures, clampTextureSize } from './clampTextureSize'
import { disposeOwnedObject3D, markSharedAssetResources } from './sharedAsset'
import { cloneGltfInstance } from './skinnedMeshInstance'
import { mergeStaticGltfInPlace } from './mergeStaticGltfLeaves'
import { prepareAvatarMaterials, prepareEmotePropMaterials } from '../avatar/materials'
import { prepareWearableCacheRoot } from '../avatar/wearableCache'
import { clearLocomotionClipCache } from '../avatar/locomotionClipCache'
import { disposeSessionAudioBufferCache } from '../media/AudioBufferCache'
import { collectManifestAssets } from './manifestAssets'
import { isSceneBytesWarm } from './sceneLoadWarm'
import {
  guessImageMimeFromBytes,
  guessImageMimeFromUrl,
  preferFetchTextureLoad,
  proxiedTextureUrl
} from './textureProxy'
import {
  installGltfSidecarTextureHandler,
  registerGltfSidecarTexturePlugin
} from './gltfSidecarTexture'

const LANDSCAPE_CACHE_SUFFIX = '#landscape'
const WEARABLE_CACHE_SUFFIX = '#wearable'
const EMOTE_CACHE_SUFFIX = '#emote'
const GPU_KIND_SUFFIX_RE = /#(landscape|wearable|emote)$/

function glbCacheKey(
  hashOrUrl: string,
  options?: { landscape?: boolean; wearable?: boolean; emote?: boolean }
): string {
  const base = normalizeGlbCacheKey(hashOrUrl)
  if (options?.landscape) return `${base}${LANDSCAPE_CACHE_SUFFIX}`
  if (options?.wearable) return `${base}${WEARABLE_CACHE_SUFFIX}`
  if (options?.emote) return `${base}${EMOTE_CACHE_SUFFIX}`
  return base
}

function glbBytesKey(cacheKey: string): string {
  return cacheKey.replace(GPU_KIND_SUFFIX_RE, '')
}

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
  disposeSessionAudioBufferCache()
}

const prefetchedSceneIds = new Set<string>()

/**
 * Warm GLB **and PNG/JPG bytes** into IndexedDB with the scene manifest.
 * Decode still happens at attach (TextureLoader); bytes must be local so
 * neighbor meshes are textured on first appear — not beige-then-later.
 */
export function prefetchSceneManifestAssets(cache: AssetCache, scene: ResolvedScene): void {
  const sceneKey = scene.entityId ?? scene.title
  if (sceneKey && prefetchedSceneIds.has(sceneKey)) return

  const { glbs, textures, audio } = collectManifestAssets(scene)
  if (!glbs.length && !textures.length && !audio.length) return

  if (sceneKey) prefetchedSceneIds.add(sceneKey)

  const byteJobs = [...glbs, ...textures]
  const parts: string[] = []
  if (textures.length) parts.push(`${textures.length} PNG(s) with GLBs`)
  if (audio.length) parts.push(`${audio.length} MP3(s) on-demand`)

  if (!byteJobs.length) {
    console.info(`[assets] scene manifest — ${parts.join(', ') || 'empty'}`)
    return
  }

  void (async () => {
    try {
      const glbsWarm = await isSceneBytesWarm(scene)
      const jobs = glbsWarm ? textures : byteJobs
      if (!jobs.length) {
        console.info(
          `[assets] IDB warm — skip main-thread transfer of ${glbs.length} GLB(s)` +
            (parts.length ? `; ${parts.join(', ')}` : '')
        )
        return
      }
      const CONCURRENCY = 12
      console.info(
        `[assets] prefetching ${glbsWarm ? 0 : glbs.length} GLB(s)` +
          (textures.length ? ` + ${textures.length} PNG(s)` : '') +
          ` into IDB (concurrency=${CONCURRENCY})` +
          (audio.length ? `; ${audio.length} MP3(s) on-demand` : '')
      )
      for (let i = 0; i < jobs.length; i += CONCURRENCY) {
        const batch = jobs.slice(i, i + CONCURRENCY)
        await Promise.all(batch.map(({ url, hash }) => cache.prefetchBytesSettled(url, hash)))
        await new Promise<void>((r) => setTimeout(r, 0))
      }
    } catch {
      /* best-effort warm */
    }
  })()
}

/** @deprecated Use `prefetchSceneManifestAssets` */
export function prefetchSceneManifestGlbs(cache: AssetCache, scene: ResolvedScene): void {
  prefetchSceneManifestAssets(cache, scene)
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
  /** Bumped when the play WebGL context dies — in-flight parses must not re-insert. */
  private gpuEpoch = 0
  /**
   * Cap concurrent GLB parses. Was 1 → only ~1 asset finished at a time (5+ min plaza).
   * Loading screen can absorb a few parallel main-thread parses; off-thread uses workers.
   */
  private parseSlotsInUse = 0
  private readonly parseWaiters: Array<() => void> = []
  private loggedWorkerFallback = false
  private static readonly MAX_CONCURRENT_PARSES = 4
  private static readonly FAILED_RETRY_MS = 2_000
  private static readonly MAX_LOAD_ATTEMPTS = 5

  constructor() {
    const manager = new THREE.LoadingManager()
    manager.setURLModifier((url) => resolveDclAssetUrl(url))
    // Image extensions only — GLTFLoader asks getHandler() for image URIs, not .bin.
    installGltfSidecarTextureHandler(manager)

    const draco = new DRACOLoader()
    draco.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.7/')
    this.loader = new GLTFLoader(manager)
    this.loader.setDRACOLoader(draco)
    registerGltfSidecarTexturePlugin(this.loader)
    this.textureLoader = new THREE.TextureLoader(manager)
  }

  /** Wire scene content manifest into the global glTF URL rewriter. */
  setScene(scene: ResolvedScene): void {
    configureSceneContent(scene.content, scene.assetUrl, scene.entityId)
  }

  /** Drop one resident manifest (slot dispose). Other scenes stay resolvable. */
  unregisterScene(entityId: string): void {
    unregisterSceneContent(entityId)
  }

  clearScene(): void {
    clearSceneContent()
  }

  /**
   * Drop parsed Three.js GPU objects after the play renderer is destroyed.
   * `/goto` rebuilds World + WebGLRenderer (`forceContextLoss`); ImageBitmap
   * maps uploaded to the dead context render as a black silhouette. IDB GLB
   * bytes stay warm so the next compose re-inflates without a network hit.
   */
  invalidateGpuResources(reason = 'renderer-rebuild'): void {
    this.gpuEpoch++
    const dropped = this.cache.size + this.textures.size
    for (const entry of this.cache.values()) {
      disposeCachedRoot(entry.root)
    }
    this.cache.clear()
    this.inflight.clear()
    for (const texture of this.textures.values()) {
      disposeTexture(texture)
    }
    this.textures.clear()
    this.textureInflight.clear()
    if (dropped > 0) {
      console.info(
        `[AssetCache] dropped ${dropped} parsed GPU entries after ${reason} — IDB bytes stay warm`
      )
    }
  }

  /**
   * Release cached GLBs/textures. Only call from `disposeSessionAssetCache` on sign-out —
   * parcel navigation keeps the session cache alive and only clears the scene manifest.
   */
  dispose(): void {
    this.invalidateGpuResources('session-dispose')
    this.bytesInflight.clear()
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
    return this.cache.has(normalizeGlbCacheKey(key))
  }

  /** Sync template peek — only for attach/clone when already parsed (never triggers load). */
  peekCached(key: string): CachedGltf | undefined {
    return this.cache.get(normalizeGlbCacheKey(key))
  }

  /** Drop a parsed GLB so the next load re-fetches bytes (e.g. after terrain re-save). */
  evict(key: string): void {
    const cacheKey = normalizeGlbCacheKey(key)
    const entry = this.cache.get(cacheKey)
    if (entry) {
      disposeCachedRoot(entry.root)
      this.cache.delete(cacheKey)
    }
    this.inflight.delete(cacheKey)
    this.bytesInflight.delete(cacheKey)
    this.givenUp.delete(cacheKey)
    this.failedUntil.delete(cacheKey)
    this.failCount.delete(cacheKey)
    this.warnedFailed.delete(cacheKey)
    void deleteGlbBytes(cacheKey)
  }

  /** LSD UpdateModel: drop one scene file (GLB or texture) by hash and/or src. */
  evictSceneAsset(scene: { content: Array<{ file: string; hash: string }>; assetUrl: (hash: string) => string }, opts: { src?: string; hash?: string }): void {
    let hash = opts.hash?.trim() || ''
    const src = opts.src?.trim() || ''
    if (!hash && src) {
      const hit = scene.content.find(
        (c) => c.file === src || c.file.endsWith(`/${src}`) || src.endsWith(c.file)
      )
      if (hit) hash = hit.hash
    }
    if (hash) this.evict(hash)
    if (src) {
      const url = hash ? scene.assetUrl(hash) : src
      const tex = this.textures.get(url)
      if (tex) {
        disposeTexture(tex)
        this.textures.delete(url)
      }
      this.textureInflight.delete(url)
    }
  }

  /** True when bytes or parse is in flight — used to prioritize attach passes. */
  isResolving(key: string): boolean {
    const k = normalizeGlbCacheKey(key)
    return this.inflight.has(k) || this.bytesInflight.has(k)
  }

  hasGivenUp(key: string): boolean {
    return this.givenUp.has(normalizeGlbCacheKey(key))
  }

  hasPendingLoads(): boolean {
    return this.inflight.size > 0 || this.bytesInflight.size > 0 || this.textureInflight.size > 0
  }

  /** Wait until raw GLB byte prefetches settle (or timeout). Does not parse to Three. */
  async waitForPrefetchBytes(timeoutMs = 60_000): Promise<{ remaining: number; waitedMs: number }> {
    const started = performance.now()
    while (this.bytesInflight.size > 0 && performance.now() - started < timeoutMs) {
      const pending = [...this.bytesInflight.values()]
      await Promise.race([
        Promise.allSettled(pending),
        new Promise<void>((r) => setTimeout(r, 250))
      ])
    }
    return { remaining: this.bytesInflight.size, waitedMs: performance.now() - started }
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

  /** Download GLB bytes only — drop buffer after settle (IDB warm). Does not parse. */
  prefetchBytes(url: string, hash?: string): void {
    void this.prefetchBytesSettled(url, hash)
  }

  /**
   * Prefetch that settles when the worker has finished IDB/network work.
   * Buffer is not retained after settle (load() re-reads IDB). Concurrent load() can
   * still await the same inflight promise while it is live.
   */
  prefetchBytesSettled(url: string, hash?: string): Promise<void> {
    const key = normalizeGlbCacheKey(hash ?? url)
    if (this.cache.has(key) || this.inflight.has(key) || this.givenUp.has(key)) {
      return Promise.resolve()
    }
    const existing = this.bytesInflight.get(key)
    if (existing) return existing.then(() => undefined).catch(() => undefined)

    const retryAt = this.failedUntil.get(key) ?? 0
    if (performance.now() < retryAt) return Promise.resolve()

    const task = fetchGlbBytesOffThread(url, key).finally(() => {
      this.bytesInflight.delete(key)
    })
    this.bytesInflight.set(key, task)
    return task.then(() => undefined).catch(() => undefined)
  }

  async preloadTextures(urls: string[]): Promise<void> {
    await Promise.all(urls.map((url) => this.loadTexture(url)))
  }

  /** Fire-and-forget texture warmup — deduped via `loadTexture`. */
  prefetchTextures(urls: string[]): void {
    for (const url of urls) {
      void this.loadTexture(url).catch(() => {})
    }
  }

  async load(
    url: string,
    hash?: string,
    options?: { emote?: boolean; wearable?: boolean; quiet?: boolean; landscape?: boolean }
  ): Promise<CachedGltf> {
    const key = glbCacheKey(hash ?? url, options)
    const hit = this.cache.get(key)
    if (hit) return hit

    const pending = this.inflight.get(key)
    if (pending) return pending

    const epoch = this.gpuEpoch
    const task = this.loadFromDbOrNetwork(url, key, options)
      .then((entry) => {
        if (epoch !== this.gpuEpoch) {
          disposeCachedRoot(entry.root)
          this.inflight.delete(key)
          return entry
        }
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
    options?: { emote?: boolean; wearable?: boolean; quiet?: boolean; landscape?: boolean }
  ): Promise<CachedGltf> {

    const gltf = await this.fetchAndParseGltf(url, glbBytesKey(key), options?.quiet)
    const entry: CachedGltf = {
      root: gltf.scene,
      animations: gltf.animations ?? []
    }
    if (options?.wearable) {
      prepareAvatarMaterials(entry.root)
      prepareWearableCacheRoot(entry.root)
    } else if (options?.landscape) {
      sanitizeLandscapeGltf(entry.root)
    } else if (!options?.emote) {
      sanitizeSceneGltfColliders(entry.root)
      sanitizeSceneGltfMaterials(entry.root)
      applySceneGltfEmissives(entry.root)
      bindGltfWaterSurface(entry.root, url, (texUrl) => this.loadTexture(texUrl))
      if (entry.animations.length === 0) {
        mergeStaticGltfInPlace(entry.root)
        const backup = entry.root.userData.dclUnmergedRoot as THREE.Object3D | undefined
        if (backup) markSharedAssetResources(backup)
      }
    } else {
      // Emote props (dontsee cards, money particles, hammer) need the same material
      // prep as wearables — sRGB maps + double-side alpha cards; hide colliders only.
      entry.root.traverse((obj) => {
        if (/collider/i.test(obj.name)) obj.visible = false
      })
      prepareAvatarMaterials(entry.root)
      prepareEmotePropMaterials(entry.root)
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
  async clone(
    url: string,
    hash?: string,
    options?: { landscape?: boolean; sceneGltf?: boolean }
  ): Promise<THREE.Group> {
    const { root } = await this.load(url, hash, {
      landscape: options?.landscape,
      quiet: options?.landscape
    })
    const instance = cloneGltfInstance(root)
    if (options?.sceneGltf) {
      enableSceneGltfVertexColors(instance)
    } else if (!options?.landscape) {
      retuneScenePlantCutoutMaterials(instance)
    }
    return instance
  }

  private gltfResourcePath(url: string): string {
    const clean = url.split('?')[0]!.split('#')[0]!
    const slash = clean.lastIndexOf('/')
    return slash >= 0 ? `${clean.slice(0, slash + 1)}` : ''
  }

  private acquireParseSlot(): Promise<void> {
    if (this.parseSlotsInUse < AssetCache.MAX_CONCURRENT_PARSES) {
      this.parseSlotsInUse++
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.parseWaiters.push(() => {
        this.parseSlotsInUse++
        resolve()
      })
    })
  }

  private releaseParseSlot(): void {
    this.parseSlotsInUse = Math.max(0, this.parseSlotsInUse - 1)
    const next = this.parseWaiters.shift()
    if (next) next()
  }

  /**
   * Same pipeline as the parse worker: GLTFLoader.parseAsync → flattenGltf → inflateGltf.
   * Runs on this thread so Apple/WebKit never transfers ImageBitmaps across workers
   * (that upload path paints solid white). Skeleton bind matches desktop inflate.
   */
  private async rebuildGltfOnMainThread(
    buffer: ArrayBuffer,
    resourcePath: string
  ): Promise<{ scene: THREE.Group; animations: THREE.AnimationClip[] }> {
    const parsed = await this.loader.parseAsync(buffer, resourcePath)
    const payload = await flattenGltf(parsed.scene, parsed.animations ?? [])
    return inflateGltf(payload)
  }

  private async fetchAndParseGltf(url: string, cacheKey: string, quiet?: boolean) {
    let buffer = await this.resolveGlbBytes(url, cacheKey, quiet)

    const resourcePath = this.gltfResourcePath(url)
    // Serialize parse + yield so rAF can run between multi-second GLB parses.
    await this.acquireParseSlot()
    try {
      // Yield before and after parse so rAF/UI can run around multi-second main-thread parses.
      await new Promise<void>((r) => setTimeout(r, 0))
      let result: { scene: THREE.Group; animations: THREE.AnimationClip[] }
      if (isGlbOffThreadParseEnabled()) {
        try {
          const parsed = await parseGlbOffThread(buffer, resourcePath, buildParseUrlMappings())
          result = { scene: parsed.scene, animations: parsed.animations }
        } catch (err) {
          // Worker init / flatten miss — same path as Apple: parse + flatten + inflate on main.
          if (!this.loggedWorkerFallback) {
            this.loggedWorkerFallback = true
            console.warn(
              '[assets] GLB parse worker failed — main-thread flatten/inflate',
              err instanceof Error ? err.message : err
            )
          }
          result = await this.rebuildGltfOnMainThread(buffer, resourcePath)
        }
      } else {
        // Apple / Brave / ?mainglb: exact same flatten→inflate as the worker, no transfer.
        result = await this.rebuildGltfOnMainThread(buffer, resourcePath)
      }
      clampObject3DTextures(result.scene)
      await new Promise<void>((r) => setTimeout(r, 0))
      return result
    } finally {
      this.releaseParseSlot()
    }
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
    const fetchUrl = proxiedTextureUrl(url)
    const hit = this.textures.get(url) ?? this.textures.get(fetchUrl)
    if (hit) {
      this.textures.delete(url)
      this.textures.set(url, hit)
      return hit
    }

    if (this.givenUp.has(url)) {
      throw new Error(`texture load given up: ${url}`)
    }

    const pending = this.textureInflight.get(url)
    if (pending) return pending

    const task = this.loadTextureData(fetchUrl)
      .then((tex) => {
        this.textures.set(url, tex)
        this.textureInflight.delete(url)
        this.failedUntil.delete(url)
        this.failCount.delete(url)
        this.givenUp.delete(url)
        return tex
      })
      .catch((err) => {
        this.textureInflight.delete(url)
        const attempts = (this.failCount.get(url) ?? 0) + 1
        this.failCount.set(url, attempts)
        if (attempts >= AssetCache.MAX_LOAD_ATTEMPTS) {
          this.givenUp.add(url)
          this.failedUntil.delete(url)
        } else {
          this.failedUntil.set(url, performance.now() + AssetCache.FAILED_RETRY_MS)
        }
        if (!this.warnedFailed.has(url)) {
          this.warnedFailed.add(url)
          const detail = err instanceof Error ? err.message : String(err?.type ?? err)
          console.warn('[AssetCache] texture load failed', fetchUrl, detail)
        }
        throw err instanceof Error ? err : new Error(`texture load failed: ${url}`)
      })

    this.textureInflight.set(url, task)
    return task
  }

  private async loadTextureData(url: string): Promise<THREE.Texture> {
    if (preferFetchTextureLoad(url)) {
      return this.loadTextureViaFetch(url)
    }
    try {
      const tex = await this.textureLoader.loadAsync(url)
      clampTextureSize(tex)
      return tex
    } catch (err) {
      // Peer content can flip between image/* and octet-stream+nosniff; retry via fetch.
      try {
        return await this.loadTextureViaFetch(url)
      } catch {
        throw err
      }
    }
  }

  /**
   * fetch + decode — follows redirects; works through same-origin proxy.
   * Peer content serves PNG as application/octet-stream + nosniff: Image(src=url)
   * refuses those. We fetch bytes, re-type the Blob, then decode.
   *
   * Prefer HTMLImageElement so `Texture.flipY` works (MeshRenderer vs GLTF).
   * Three.js: flipY has **no effect** on ImageBitmap — that left Jump Zone board
   * textures upside-down after the ImageBitmap path landed. Delayed blob: revoke
   * avoids the prior blank-texture race without needing ImageBitmap.
   */
  private async loadTextureViaFetch(url: string): Promise<THREE.Texture> {
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

    // HTMLImageElement — flipY honored by WebGL upload (ImageBitmap ignores it).
    const image = await loadImageFromBlob(blob)
    const tex = new THREE.Texture(image)
    tex.colorSpace = THREE.SRGBColorSpace
    tex.needsUpdate = true
    tex.flipY = true
    clampTextureSize(tex)
    return tex
  }
}

/** Fallback when createImageBitmap is missing/fails — keep blob URL until onload. */
function loadImageFromBlob(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob)
    const img = new Image()
    img.onload = () => {
      const finish = (): void => {
        // iOS Safari uploads WebGL on a later frame — revoke-on-0 leaves white textures.
        const ios =
          typeof navigator !== 'undefined' &&
          (/iPad|iPhone|iPod/i.test(navigator.userAgent) ||
            ((navigator.maxTouchPoints ?? 0) > 1 && /Mac/i.test(navigator.platform || '')))
        // Never revoke on iOS — GPU may sample the blob URL on later frames.
        if (!ios) setTimeout(() => URL.revokeObjectURL(objectUrl), 0)
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

const TEXTURE_SLOTS = [
  'map',
  'normalMap',
  'roughnessMap',
  'metalnessMap',
  'aoMap',
  'emissiveMap',
  'alphaMap',
  'bumpMap',
  'displacementMap',
  'lightMap',
  'envMap',
  'clearcoatMap',
  'clearcoatNormalMap',
  'clearcoatRoughnessMap',
  'transmissionMap',
  'thicknessMap',
  'specularIntensityMap',
  'specularColorMap',
  'sheenColorMap',
  'sheenRoughnessMap',
  'iridescenceMap',
  'iridescenceThicknessMap',
  'anisotropyMap'
] as const

function disposeTexture(texture: THREE.Texture): void {
  const image = texture.image as { close?: () => void } | undefined
  texture.dispose()
  if (image && typeof image.close === 'function') {
    try {
      image.close()
    } catch {
      /* already closed / detached */
    }
  }
}

function disposeCachedRoot(root: THREE.Object3D): void {
  const backup = root.userData.dclUnmergedRoot as THREE.Object3D | undefined
  if (backup && backup !== root) {
    disposeOwnedObject3D(backup)
    delete root.userData.dclUnmergedRoot
  }
  const seen = new Set<THREE.Texture>()
  root.traverse((node) => {
    if (!(node instanceof THREE.Mesh)) return
    node.geometry?.dispose()
    const materials = Array.isArray(node.material) ? node.material : [node.material]
    for (const material of materials) {
      if (!material) continue
      const rec = material as unknown as Record<string, unknown>
      for (const slot of TEXTURE_SLOTS) {
        const tex = rec[slot]
        if (tex instanceof THREE.Texture && !seen.has(tex)) {
          seen.add(tex)
          disposeTexture(tex)
        }
      }
      material.dispose()
    }
  })
}
