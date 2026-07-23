import * as THREE from 'three'
import { AvatarAnimations } from '../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../avatar/AvatarComposer'
import { BODY_SHAPE_URN, DEFAULT_WEARABLE_CATEGORIES, defaultWearableUrn, PEER_URL } from '../avatar/constants'
import { applyAvatarPivotOffset } from '../avatar/feetAlign'
import type { AvatarProfile, BodyShape, WearableCategory } from '../avatar/types'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { stabilizeSkinnedMeshes } from '../rendering/skinnedMeshInstance'
import { disposeOwnedObject3D } from '../rendering/sharedAsset'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

const SKIN_HEX = ['f5d0c5', 'e0ac69', 'c68642', '8d5524', 'f1c27d', 'ffdbac', 'c9a07a'] as const
const HAIR_HEX = ['1a1a1a', '4a3728', 'b55239', 'd4a017', '6b3fa0', 'c0c0c0', '2c1b18'] as const
const EYE_HEX = ['3d2314', '4a7c59', '3b6ea5', '6b4f3a', '2f2f2f', '5b7c99'] as const

/** Categories we randomize for crowd variety. */
const OUTFIT_CATEGORIES: WearableCategory[] = [
  'upper_body',
  'lower_body',
  'feet',
  'hair',
  'eyebrows',
  'eyes',
  'mouth',
  'facial_hair',
  'hat',
  'eyewear',
  'earring'
]

/**
 * Sample on-chain collections-v1 — best-effort; failures fall back to base-avatars.
 * Enough variety for multi-avatar GPU/CPU stress without owning NFTs.
 */
const ON_CHAIN_COLLECTION_IDS = [
  'urn:decentraland:ethereum:collections-v1:dg_atari',
  'urn:decentraland:ethereum:collections-v1:halloween_2019',
  'urn:decentraland:ethereum:collections-v1:xmas_2019',
  'urn:decentraland:ethereum:collections-v1:mch_collection',
  'urn:decentraland:ethereum:collections-v1:dappcraft_moonminer',
  'urn:decentraland:ethereum:collections-v1:community_contest',
  'urn:decentraland:ethereum:collections-v1:dc_niftyblocksmith'
]

const BASE_COLLECTION_ID = 'urn:decentraland:off-chain:base-avatars'

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
 * Uses Catalyst collection catalogs (base + sample on-chain) with random outfits; falls
 * back to default base URNs if catalog fetch fails.
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
        this.layoutRing()
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
    const add = (category: string, id: string) => {
      const cat = category.toLowerCase()
      const list = pool.get(cat) ?? []
      list.push(id)
      pool.set(cat, list)
    }

    // Base avatars (always try first — reliable).
    await this.fetchCollectionInto(BASE_COLLECTION_ID, add)

    // Sample on-chain collections (best-effort).
    for (const col of ON_CHAIN_COLLECTION_IDS) {
      await this.fetchCollectionInto(col, add)
    }

    // Ensure defaults exist for every outfit category.
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
      `avatar crowd catalog ready — ${pool.size} categories, ${total} urns`
    )
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

  private randomProfile(index: number): AvatarProfile {
    const bodyShape: BodyShape = Math.random() < 0.5 ? 'male' : 'female'
    const wearables: string[] = [BODY_SHAPE_URN[bodyShape]]
    const pool = this.pool

    for (const cat of OUTFIT_CATEGORIES) {
      // facial_hair only sometimes
      if (cat === 'facial_hair' && Math.random() < 0.55) continue
      if ((cat === 'hat' || cat === 'eyewear' || cat === 'earring') && Math.random() < 0.45) {
        continue
      }
      const fromPool = pool?.get(cat)
      let urn: string | null = null
      if (fromPool?.length) {
        // Prefer items that list a matching body shape when we have API metadata — pool is flat ids.
        urn = pick(fromPool)
      }
      if (!urn) urn = defaultWearableUrn(cat, bodyShape)
      if (urn) wearables.push(urn)
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
      fromWallet: true,
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
    clientDebugLog.log('debug', `crowd spawn ${this.instances.length}/${this.targetCount}`)
  }

  private layoutRing(): void {
    const feet = this.getPlayerFeet()
    const cx = feet?.x ?? 0
    const cy = feet?.y ?? 0
    const cz = feet?.z ?? 0
    const n = this.instances.length
    if (n === 0) return
    // Spiral / rings so many avatars don't stack.
    const baseR = 2.5
    for (let i = 0; i < n; i++) {
      const ring = Math.floor(i / 12)
      const slot = i % 12
      const inRing = Math.min(12, n - ring * 12)
      const angle = (slot / Math.max(1, inRing)) * Math.PI * 2 + ring * 0.35
      const r = baseR + ring * 2.2
      const inst = this.instances[i]!
      inst.root.position.set(cx + Math.sin(angle) * r, cy, cz + Math.cos(angle) * r)
      inst.root.rotation.y = angle + Math.PI
    }
  }
}
