import * as THREE from 'three'
import { AvatarAnimations } from '../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../avatar/AvatarComposer'
import {
  assetUrnFromCompleteUrn,
  BODY_SHAPE_URN,
  DEFAULT_WEARABLE_CATEGORIES,
  defaultWearableUrn,
  PEER_URL
} from '../avatar/constants'
import { applyAvatarPivotOffset } from '../avatar/feetAlign'
import type { AvatarProfile, BodyShape, WearableCategory } from '../avatar/types'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

const SKIN_HEX = ['f5d0c5', 'e0ac69', 'c68642', '8d5524', 'f1c27d', 'ffdbac', 'c9a07a'] as const
const HAIR_HEX = ['1a1a1a', '4a3728', 'b55239', 'd4a017', '6b3fa0', 'c0c0c0', '2c1b18'] as const
const EYE_HEX = ['3d2314', '4a7c59', '3b6ea5', '6b4f3a', '2f2f2f', '5b7c99'] as const

/** Marketplace / catalog categories we can put on a crowd avatar. */
const OUTFIT_CATEGORIES: WearableCategory[] = [
  'upper_body',
  'lower_body',
  'feet',
  'hair',
  'hat',
  'helmet',
  'mask',
  'eyewear',
  'earring',
  'tiara',
  'top_head',
  'facial_hair',
  'hands_wear'
]

/** Face defaults always applied so random 3–7 outfits don’t leave blank faces. */
const FACE_CATEGORIES: WearableCategory[] = ['eyebrows', 'eyes', 'mouth']

const MIN_OUTFIT_ITEMS = 3
const MAX_OUTFIT_ITEMS = 7

const MARKETPLACE_API = 'https://marketplace-api.decentraland.org/v1'
/** How many marketplace item pages to pull (first=100 each). */
const MARKETPLACE_PAGES = 4
const MARKETPLACE_PAGE_SIZE = 100

const BASE_COLLECTION_ID = 'urn:decentraland:off-chain:base-avatars'

/** Fallback on-chain collections if marketplace CORS fails. */
const ON_CHAIN_COLLECTION_IDS = [
  'urn:decentraland:ethereum:collections-v1:dg_atari',
  'urn:decentraland:ethereum:collections-v1:halloween_2019',
  'urn:decentraland:ethereum:collections-v1:xmas_2019',
  'urn:decentraland:ethereum:collections-v1:mch_collection',
  'urn:decentraland:ethereum:collections-v1:dappcraft_moonminer',
  'urn:decentraland:ethereum:collections-v1:community_contest',
  'urn:decentraland:ethereum:collections-v1:dc_niftyblocksmith',
  'urn:decentraland:ethereum:collections-v1:xmas_2020',
  'urn:decentraland:ethereum:collections-v1:mf_sammichgamer'
]

type CrowdInstance = {
  root: THREE.Group
  pivot: THREE.Group
  model: THREE.Object3D
  animations: AvatarAnimations | null
  address: string
}

type WearableApiHit = {
  id?: string
  data?: { category?: string; representations?: Array<{ bodyShapes?: string[] }> }
}

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function randomHex(list: readonly string[]): string {
  return pick(list)
}

/**
 * Spawns debug avatars in a ring around the local player for multi-avatar perf testing.
 * Outfits: random 3–7 wearables from Marketplace item search (+ Catalyst catalogs as fallback).
 */
export class DebugAvatarCrowd {
  static readonly MAX = 60
  static readonly MIN = 0

  private readonly scene: THREE.Scene
  private readonly group = new THREE.Group()
  private readonly instances: CrowdInstance[] = []
  private readonly getPlayerFeet: () => THREE.Vector3 | null
  private contentUrl: string
  private lambdasUrl: string
  /** category → wearable URNs */
  private pool: Map<string, string[]> | null = null
  private poolLoad: Promise<void> | null = null
  private targetCount = 0
  private composeSerial: Promise<void> = Promise.resolve()
  private disposed = false
  private busy = false
  /**
   * World position captured when the first crowd avatar of a session is placed.
   * Ring stays fixed here — does **not** follow the player when they walk away.
   */
  private layoutAnchor: THREE.Vector3 | null = null

  constructor(opts: {
    scene: THREE.Scene
    getPlayerFeet: () => THREE.Vector3 | null
    contentUrl?: string
    lambdasUrl?: string
  }) {
    this.scene = opts.scene
    this.getPlayerFeet = opts.getPlayerFeet
    this.contentUrl = (opts.contentUrl ?? PEER_URL).replace(/\/$/, '')
    this.lambdasUrl = (opts.lambdasUrl ?? `${this.contentUrl}/lambdas`).replace(/\/$/, '')
    // If content is peer root, lambdas is peer/lambdas
    if (!opts.lambdasUrl && !this.lambdasUrl.includes('lambdas')) {
      this.lambdasUrl = `${this.contentUrl}/lambdas`
    }
    this.group.name = 'debug-avatar-crowd'
    this.scene.add(this.group)
  }

  get count(): number {
    return this.instances.length
  }

  get target(): number {
    return this.targetCount
  }

  get isBusy(): boolean {
    return this.busy
  }

  setCatalyst(contentUrl: string, lambdasUrl?: string): void {
    this.contentUrl = contentUrl.replace(/\/$/, '')
    this.lambdasUrl = (lambdasUrl ?? `${this.contentUrl}/lambdas`).replace(/\/$/, '')
    this.pool = null
    this.poolLoad = null
  }

  /** Set absolute target count (0…MAX). Spawns/despawns asynchronously. */
  setTargetCount(n: number): void {
    this.targetCount = Math.max(DebugAvatarCrowd.MIN, Math.min(DebugAvatarCrowd.MAX, Math.floor(n)))
    void this.reconcile()
  }

  add(delta: number): void {
    this.setTargetCount(this.targetCount + delta)
  }

  clear(): void {
    this.targetCount = 0
    this.layoutAnchor = null
    void this.reconcile()
  }

  /** Idle locomotion for all instances. */
  update(delta: number): void {
    const state = {
      horizontalSpeed: 0,
      grounded: true,
      nearGround: true,
      verticalVelocity: 0,
      locomotionMode: 'walk' as const,
      jumping: false,
      doubleJumping: false,
      falling: false,
      gliding: false,
      targetLocomotionSpeed: 0
    }
    for (const inst of this.instances) {
      inst.animations?.update(delta, state)
    }
  }

  dispose(): void {
    this.disposed = true
    this.targetCount = 0
    this.layoutAnchor = null
    while (this.instances.length) {
      this.removeLast()
    }
    this.group.removeFromParent()
  }

  private async reconcile(): Promise<void> {
    this.composeSerial = this.composeSerial.then(async () => {
      if (this.disposed) return
      this.busy = true
      try {
        while (this.instances.length > this.targetCount) {
          this.removeLast()
        }
        while (this.instances.length < this.targetCount) {
          if (this.disposed) break
          await this.spawnOne()
        }
        // Do not re-layout existing avatars — positions stay where they were spawned.
      } finally {
        this.busy = false
      }
    })
    await this.composeSerial
  }

  private removeLast(): void {
    const inst = this.instances.pop()
    if (!inst) return
    inst.animations?.dispose()
    disposeOwnedObject3D(inst.model)
    inst.root.removeFromParent()
  }

  private async ensurePool(): Promise<void> {
    if (this.pool) return
    if (this.poolLoad) {
      await this.poolLoad
      return
    }
    this.poolLoad = this.loadPool().finally(() => {
      this.poolLoad = null
    })
    await this.poolLoad
  }

  private async loadPool(): Promise<void> {
    const pool = new Map<string, string[]>()
    const seen = new Set<string>()
    const add = (category: string, id: string) => {
      const cat = category.toLowerCase()
      // Asset URN only (strip token id) for Catalyst entity resolve.
      const urn = assetUrnFromCompleteUrn(id.trim())
      if (!urn || seen.has(`${cat}:${urn}`)) return
      seen.add(`${cat}:${urn}`)
      const list = pool.get(cat) ?? []
      list.push(urn)
      pool.set(cat, list)
    }

    // 1) Marketplace search — primary source of real on-chain variety.
    const marketCount = await this.fetchMarketplaceWearables(add)

    // 2) Catalyst base + sample collections (always useful; face + fallback).
    await this.fetchCollectionInto(BASE_COLLECTION_ID, add)
    for (const col of ON_CHAIN_COLLECTION_IDS) {
      await this.fetchCollectionInto(col, add)
    }

    // 3) Hard defaults so compose never goes bald/blank-faced.
    for (const shape of ['male', 'female'] as BodyShape[]) {
      for (const cat of DEFAULT_WEARABLE_CATEGORIES) {
        const urn = defaultWearableUrn(cat, shape)
        if (urn) add(cat, urn)
      }
    }

    this.pool = pool
    const total = [...pool.values()].reduce((n, a) => n + a.length, 0)
    clientDebugLog.log(
      'debug',
      `avatar crowd catalog ready — marketplace≈${marketCount} · ${pool.size} cats · ${total} unique urns`
    )
  }

  /**
   * Marketplace item search (`/v1/items?category=wearable`) — real listings with categories.
   * Multiple pages with different orderBy for variety. CORS may fail on some deploys; returns 0 then.
   */
  private async fetchMarketplaceWearables(
    add: (category: string, id: string) => void
  ): Promise<number> {
    let added = 0
    const orderings = ['newest', 'recently_listed', 'recently_sold', 'cheapest'] as const
    for (let page = 0; page < MARKETPLACE_PAGES; page++) {
      const orderBy = orderings[page % orderings.length]!
      const skip = page * MARKETPLACE_PAGE_SIZE
      // Some rarities for more diverse looks across pages.
      const rarity = page % 2 === 0 ? '' : '&rarity=epic&rarity=legendary&rarity=mythic&rarity=unique'
      const url =
        `${MARKETPLACE_API}/items?first=${MARKETPLACE_PAGE_SIZE}&skip=${skip}` +
        `&category=wearable&orderBy=${orderBy}${rarity}`
      try {
        const res = await fetch(url)
        if (!res.ok) continue
        const raw = (await res.json()) as {
          data?: Array<Record<string, unknown>>
        }
        for (const row of raw.data ?? []) {
          const item = (row.item as Record<string, unknown> | undefined) ?? row
          const urn = String(item.urn ?? item.id ?? '').trim()
          const wearable = (item.data as { wearable?: { category?: string } } | undefined)
            ?.wearable
          const cat = (wearable?.category ?? (item.category as string | undefined) ?? '')
            .trim()
            .toLowerCase()
          if (!urn || !cat) continue
          // Skip pure base face/body slots from marketplace noise.
          if (cat === 'body_shape' || cat === 'eyebrows' || cat === 'eyes' || cat === 'mouth') {
            continue
          }
          add(cat, urn)
          added++
        }
      } catch {
        /* CORS / network — collections fallback still runs */
      }
    }
    return added
  }

  private async fetchCollectionInto(
    collectionId: string,
    add: (category: string, id: string) => void
  ): Promise<void> {
    try {
      const url = `${this.lambdasUrl}/collections/wearables?collectionId=${encodeURIComponent(collectionId)}`
      const res = await fetch(url)
      if (!res.ok) return
      const raw = (await res.json()) as { wearables?: WearableApiHit[] }
      for (const w of raw.wearables ?? []) {
        const id = w.id?.trim()
        const cat = w.data?.category?.trim()
        if (id && cat) add(cat, id)
      }
    } catch {
      /* catalog optional */
    }
  }

  private pickUrn(category: WearableCategory, bodyShape: BodyShape): string | null {
    const fromPool = this.pool?.get(category)
    if (fromPool?.length) return pick(fromPool)
    return defaultWearableUrn(category, bodyShape)
  }

  private randomProfile(index: number): AvatarProfile {
    const bodyShape: BodyShape = Math.random() < 0.5 ? 'male' : 'female'
    const wearables: string[] = [BODY_SHAPE_URN[bodyShape]]

    // Face defaults (not counted in 3–7 outfit budget).
    for (const cat of FACE_CATEGORIES) {
      const urn = this.pickUrn(cat, bodyShape) ?? defaultWearableUrn(cat, bodyShape)
      if (urn) wearables.push(urn)
    }

    // Random 3–7 marketplace/catalog slots, unique categories.
    const n =
      MIN_OUTFIT_ITEMS +
      Math.floor(Math.random() * (MAX_OUTFIT_ITEMS - MIN_OUTFIT_ITEMS + 1))
    const shuffled = [...OUTFIT_CATEGORIES].sort(() => Math.random() - 0.5)
    const chosen = shuffled.slice(0, Math.min(n, shuffled.length))

    for (const cat of chosen) {
      const urn = this.pickUrn(cat, bodyShape)
      if (urn) wearables.push(urn)
    }

    // Ensure at least something on the body if marketplace was empty.
    const hasClothes = chosen.some((c) =>
      c === 'upper_body' || c === 'lower_body' || c === 'feet' || c === 'skin'
    )
    if (!hasClothes) {
      for (const cat of ['upper_body', 'lower_body', 'feet'] as WearableCategory[]) {
        const urn = this.pickUrn(cat, bodyShape) ?? defaultWearableUrn(cat, bodyShape)
        if (urn && !wearables.includes(urn)) wearables.push(urn)
      }
    }

    const addr = `0xdebug${(index + 1).toString(16).padStart(34, '0')}`.slice(0, 42)
    return {
      bodyShape,
      skin: randomHex(SKIN_HEX),
      hair: randomHex(HAIR_HEX),
      eyes: randomHex(EYE_HEX),
      wearables,
      forceRender: [],
      emotes: [],
      // false so resolveProfile can backfill base defaults when a marketplace URN fails.
      fromWallet: false,
      address: addr,
      displayName: `Crowd ${index + 1}`,
      hasClaimedName: false
    }
  }

  private async spawnOne(): Promise<void> {
    await this.ensurePool()
    const index = this.instances.length
    const profile = this.randomProfile(index)

    let model: THREE.Object3D
    try {
      model = await composeAvatarFromProfile(profile, this.contentUrl, getSessionAssetCache())
    } catch (err) {
      clientDebugLog.log(
        'debug',
        `crowd spawn failed #${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'warn' }
      )
      // Fallback bare default profile
      const fallback = this.randomProfile(index)
      fallback.wearables = [BODY_SHAPE_URN[fallback.bodyShape]]
      for (const cat of DEFAULT_WEARABLE_CATEGORIES) {
        const u = defaultWearableUrn(cat, fallback.bodyShape)
        if (u) fallback.wearables.push(u)
      }
      model = await composeAvatarFromProfile(fallback, this.contentUrl, getSessionAssetCache())
    }

    if (this.disposed || this.instances.length >= this.targetCount) {
      disposeOwnedObject3D(model)
      return
    }

    stabilizeSkinnedMeshes(model)
    repairCrowdBlackMaterials(model, profile.skin)
    const root = new THREE.Group()
    root.name = `debug-crowd-${index}`
    const pivot = new THREE.Group()
    pivot.add(model)
    applyAvatarPivotOffset(pivot, model)
    root.add(pivot)
    this.group.add(root)

    let animations: AvatarAnimations | null = new AvatarAnimations()
    try {
      await animations.bind(model, pivot, {
        bodyShape: profile.bodyShape,
        peerUrl: this.contentUrl,
        assetCache: getSessionAssetCache()
      })
      animations.setVfxScene(this.scene)
    } catch {
      animations.dispose()
      animations = null
    }

    this.instances.push({
      root,
      pivot,
      model,
      animations,
      address: profile.address ?? `crowd-${index}`
    })
    // Place this instance only once around a fixed anchor (does not follow player).
    this.placeInstance(root, this.instances.length - 1)
    clientDebugLog.log('debug', `crowd spawn ${this.instances.length}/${this.targetCount}`)
  }

  /**
   * Place a single avatar in a spiral ring around {@link layoutAnchor}.
   * Anchor is frozen at first placement — later player movement does not move the crowd.
   */
  private placeInstance(root: THREE.Group, index: number): void {
    if (!this.layoutAnchor) {
      const feet = this.getPlayerFeet()
      this.layoutAnchor =
        feet && Number.isFinite(feet.x) && Number.isFinite(feet.z)
          ? feet.clone()
          : new THREE.Vector3(0, 0, 0)
    }
    const { x: cx, y: cy, z: cz } = this.layoutAnchor
    const ring = Math.floor(index / 12)
    const slot = index % 12
    const inRing = 12
    const angle = (slot / inRing) * Math.PI * 2 + ring * 0.35
    const r = 2.5 + ring * 2.2
    root.position.set(cx + Math.sin(angle) * r, cy, cz + Math.cos(angle) * r)
    root.rotation.y = angle + Math.PI
  }
}

/**
 * Marketplace / failed GLB textures often leave MeshStandardMaterial with a broken map
 * or pure black baseColor → solid black clothing. Lift broken maps and black metals.
 */
function repairCrowdBlackMaterials(root: THREE.Object3D, skinHex: string): void {
  const skinColor = new THREE.Color(`#${skinHex.replace('#', '')}`)
  root.traverse((obj) => {
    if (!(obj as THREE.Mesh).isMesh) return
    const mesh = obj as THREE.Mesh
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const mat of mats) {
      if (!mat || !('isMeshStandardMaterial' in mat)) continue
      const m = mat as THREE.MeshStandardMaterial
      const name = (m.name ?? '').toLowerCase()
      const mapBroken = isTextureBroken(m.map)
      if (mapBroken) {
        m.map = null
        m.needsUpdate = true
      }
      const luma = m.color.r + m.color.g + m.color.b
      // Pure black + no usable map → unreadable silhouette
      if (luma < 0.04 && !m.map) {
        if (name.includes('skin') || name.includes('avatarskin')) {
          m.color.copy(skinColor)
        } else {
          m.color.setRGB(0.45, 0.45, 0.48)
        }
        m.metalness = Math.min(m.metalness, 0.15)
        m.roughness = Math.max(m.roughness, 0.65)
        m.needsUpdate = true
      } else if (m.metalness > 0.92 && luma < 0.12 && !m.envMap) {
        // Chrome-black without env map reads as a void silhouette in our lighting.
        m.metalness = 0.2
        m.roughness = Math.max(m.roughness, 0.55)
        if (luma < 0.08) m.color.setRGB(0.35, 0.35, 0.38)
        m.needsUpdate = true
      }
    }
  })
}

function isTextureBroken(tex: THREE.Texture | null | undefined): boolean {
  if (!tex) return true
  const img = tex.image as
    | { complete?: boolean; naturalWidth?: number; width?: number; height?: number }
    | undefined
  if (!img) return true
  if (img.complete === false) return true
  if (typeof img.naturalWidth === 'number' && img.naturalWidth === 0) return true
  const w = img.width ?? img.naturalWidth ?? 0
  const h = img.height ?? 0
  return w < 1 || h < 1
}
