import * as THREE from 'three'
import type { AssetCache } from '../../rendering/AssetCache'
import type { ResolvedScene } from '../content/types'
import { parseParcelKey } from '../content/parseParcel'
import { EMPTY_LAND } from '../landscape/Data/EmptyLandCatalog'
import { buildInstancedGroundTiles } from '../landscape/gltfInstancing'
import { buildEmptyParcelScatter } from './emptyParcelLayer'
import {
  ensureExplorerRoadsReady,
  buildInstancedRoadLayer,
  type RoadTilePlacement
} from './roadTiles'
import {
  getExplorerRoadEntry,
  isExplorerRoadParcel,
  loadExplorerRoadCatalog
} from './explorerRoadCatalog'
import { parcelSwSceneLocal } from './parcelAoi'

/**
 * Visual fill for synthetic empty / open-road primaries (no SDK7 main entry).
 * - Explorer road catalog parcel → instanced road FBX (tile + furniture)
 * - Otherwise → empty-land ground.glb + light prop scatter (AOI empty layer style)
 */
export async function attachPrimaryVacantFill(
  scene: ResolvedScene,
  cache: AssetCache,
  hostScene: THREE.Scene,
  onProgress?: (msg: string) => void
): Promise<THREE.Group | null> {
  if (scene.source.kind !== 'coords') return null
  if (scene.mainEntry?.trim() || scene.entityId?.trim()) return null

  const parcels = scene.parcels.length ? scene.parcels : [scene.baseParcel]
  if (!parcels.length) return null

  const base = scene.baseParcel
  const root = new THREE.Group()
  root.name = 'primary-vacant-fill'

  onProgress?.('Loading Explorer road catalog…')
  await loadExplorerRoadCatalog()
  await ensureExplorerRoadsReady()

  const roadParcels: string[] = []
  const emptyParcels: string[] = []
  for (const key of parcels) {
    const k = key.trim()
    if (!k) continue
    if (isExplorerRoadParcel(k) || getExplorerRoadEntry(k)) roadParcels.push(k)
    else emptyParcels.push(k)
  }

  if (roadParcels.length) {
    onProgress?.(`Building road tiles (${roadParcels.length})…`)
    const placements: RoadTilePlacement[] = []
    for (const parcelKey of roadParcels) {
      const entry = getExplorerRoadEntry(parcelKey)
      if (!entry) continue
      placements.push({
        entityId: `parcel:${parcelKey}`,
        parcelKey,
        model: entry.model,
        rotation: entry.rotation,
        source: 'explorer-catalog'
      })
    }
    if (placements.length) {
      try {
        const built = await buildInstancedRoadLayer({
          placements,
          primaryBase: base,
          cache,
          contentBaseUrl: scene.realm.contentUrl
        })
        root.add(built.root)
        console.info(
          `[vacant] primary roads parcels=${placements.length} source=explorer-catalog`
        )
      } catch (err) {
        console.warn('[vacant] primary road build failed', err)
      }
    }
  }

  if (emptyParcels.length) {
    onProgress?.(`Empty land ground (${emptyParcels.length})…`)
    const blankTiles = emptyParcels.map((key) => {
      const sw = parcelSwSceneLocal(key, base)
      return { x: sw.x, z: sw.z }
    })
    try {
      const blankGroup = await buildInstancedGroundTiles(
        cache,
        EMPTY_LAND.ground,
        blankTiles,
        'primary-blank-ground',
        parseParcelKey(base)
      )
      root.add(blankGroup)
    } catch (err) {
      console.warn('[vacant] primary blank ground failed', err)
    }

    try {
      const scatter = await buildEmptyParcelScatter({
        cache,
        parcelKeys: emptyParcels,
        primaryBase: base
      })
      root.add(scatter)
    } catch (err) {
      console.warn('[vacant] primary empty scatter failed', err)
    }
    console.info(`[vacant] primary empty fill parcels=${emptyParcels.length}`)
  }

  if (!root.children.length) {
    root.clear()
    return null
  }

  hostScene.add(root)
  return root
}

export function disposePrimaryVacantFill(root: THREE.Object3D | null | undefined): void {
  if (!root) return
  root.removeFromParent()
  root.traverse((obj) => {
    if (obj instanceof THREE.Mesh) {
      obj.geometry?.dispose()
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      for (const m of mats) {
        // Shared materials from road/empty templates — only dispose if not shared later;
        // geometry dispose is the main GPU cleanup; materials are often template-shared.
        void m
      }
    }
    if (obj instanceof THREE.InstancedMesh) {
      obj.geometry?.dispose()
      obj.dispose?.()
    }
  })
}
