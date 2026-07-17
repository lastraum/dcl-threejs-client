import type { Entity } from '@dcl/ecs'
import type { PBAssetLoad } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/asset_load.gen'
import type { PBAssetLoadLoadingState } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/asset_load_loading_state.gen'
import type { ResolvedScene } from '../dcl/content/types'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { AssetCache } from '../rendering/AssetCache'
import { findSceneContentHash, resolveGltfSrcHash } from '../rendering/DclTextureResolver'
import { getSessionAudioBufferCache } from './AudioBufferCache'

/** LoadingState enum (const enum not importable under isolatedModules). */
const LS_UNKNOWN = 0
const LS_LOADING = 1
const LS_NOT_FOUND = 2
const LS_FINISHED_WITH_ERROR = 3
const LS_FINISHED = 4

type RecordAppend = (componentId: number, entity: Entity, value: unknown) => void

/**
 * ECS AssetLoad (1213) — pre-download scene assets into renderer caches.
 * Writes grow-only AssetLoadLoadingState (1214) per asset (Unity host parity).
 *
 * Only scene-manifest paths are supported (no external URLs), per SDK docs.
 */
export class AssetLoadBridge {
  private timestamp = 1
  /** entity → sorted asset key list last seen */
  private lastLists = new Map<Entity, string>()
  /** entity|asset → in-flight or finished */
  private seen = new Set<string>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly scene: ResolvedScene,
    private readonly cache: AssetCache,
    private readonly recordAppend?: RecordAppend
  ) {}

  dispose(): void {
    this.lastLists.clear()
    this.seen.clear()
  }

  /** Diff AssetLoad components and start preloads. Safe to call each sync frame. */
  sync(view: ProjectionView): void {
    const { AssetLoad } = this.ecs
    const live = new Set<Entity>()

    for (const [entity, raw] of view.getEntitiesWith(AssetLoad)) {
      live.add(entity)
      const spec = raw as PBAssetLoad
      const assets = (spec.assets ?? [])
        .map((a) => (typeof a === 'string' ? a.trim() : ''))
        .filter(Boolean)
      const key = assets.slice().sort().join('\0')
      if (this.lastLists.get(entity) === key) continue
      this.lastLists.set(entity, key)
      for (const asset of assets) {
        void this.loadOne(entity, asset)
      }
    }

    for (const entity of [...this.lastLists.keys()]) {
      if (!live.has(entity)) this.lastLists.delete(entity)
    }
  }

  private loadKey(entity: Entity, asset: string): string {
    return `${entity as number}|${asset}`
  }

  private emit(entity: Entity, asset: string, currentState: number): void {
    const { AssetLoadLoadingState } = this.ecs
    const event: PBAssetLoadLoadingState = {
      currentState,
      asset,
      timestamp: this.timestamp++
    }
    try {
      AssetLoadLoadingState.addValue(entity, event)
    } catch {
      /* grow-only may not exist on projection facade until first define */
    }
    this.recordAppend?.(AssetLoadLoadingState.componentId, entity, event)
  }

  private async loadOne(entity: Entity, asset: string): Promise<void> {
    const k = this.loadKey(entity, asset)
    if (this.seen.has(k)) return
    this.seen.add(k)

    this.emit(entity, asset, LS_LOADING)

    const resolved = this.resolveSceneAsset(asset)
    if (!resolved) {
      this.emit(entity, asset, LS_NOT_FOUND)
      return
    }

    try {
      await this.prefetchResolved(resolved)
      this.emit(entity, asset, LS_FINISHED)
    } catch {
      this.emit(entity, asset, LS_FINISHED_WITH_ERROR)
    }
  }

  private resolveSceneAsset(asset: string): { kind: 'glb' | 'texture' | 'audio' | 'bytes'; url: string; hash: string } | null {
    const hash =
      resolveGltfSrcHash(this.scene.content, asset) ?? findSceneContentHash(this.scene.content, asset)
    if (!hash || hash.startsWith('local://')) {
      // Bundled local paths still have a usable URL form for some loaders.
      if (hash?.startsWith('local://')) {
        return { kind: classifyAsset(asset), url: hash.replace(/^local:\/\//, '/'), hash }
      }
      return null
    }
    const url = this.scene.assetUrl(hash)
    return { kind: classifyAsset(asset), url, hash }
  }

  private async prefetchResolved(resolved: {
    kind: 'glb' | 'texture' | 'audio' | 'bytes'
    url: string
    hash: string
  }): Promise<void> {
    switch (resolved.kind) {
      case 'glb':
        // Full parse into GLTF cache so first attach is warm (docs: "ready to use").
        await this.cache.load(resolved.url, resolved.hash, { quiet: true })
        return
      case 'texture':
        await this.cache.loadTexture(resolved.url)
        return
      case 'audio':
        await getSessionAudioBufferCache().load(resolved.url)
        return
      default:
        await this.cache.prefetchBytesSettled(resolved.url, resolved.hash)
    }
  }
}

function classifyAsset(path: string): 'glb' | 'texture' | 'audio' | 'bytes' {
  const lower = path.split('?')[0]!.split('#')[0]!.toLowerCase()
  if (/\.(glb|gltf)$/.test(lower)) return 'glb'
  if (/\.(png|jpe?g|webp|ktx2|tga|bmp|gif)$/.test(lower)) return 'texture'
  if (/\.(mp3|ogg|wav|m4a|aac)$/.test(lower)) return 'audio'
  return 'bytes'
}

// silence unused if enum imported elsewhere
void LS_UNKNOWN
