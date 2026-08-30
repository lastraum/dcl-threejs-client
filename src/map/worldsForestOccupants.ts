/**
 * Sit real DCL avatars at occupied pools (Places connected_addresses).
 */
import * as THREE from 'three'
import { composeAvatarFromProfile } from '../avatar/AvatarComposer'
import { AVATAR_YAW_OFFSET } from '../avatar/constants'
import { identityFromAvatarProfile, shortenAddress } from '../avatar/displayName'
import { remapClipToAvatar } from '../avatar/emoteBoneMap'
import { applyAvatarPivotOffset } from '../avatar/feetAlign'
import { findHeadBone, updateNameTagAnchor } from '../avatar/headAnchor'
import { createGltfLoader, disposeWearableInstance } from '../avatar/loadWearable'
import { resolveAvatarProfile } from '../avatar/peerApi'
import { NameTag } from '../client/ui/NameTag'
import { getSessionAssetCache } from '../rendering/AssetCache'
import { yieldToNextFrame } from '../rendering/mainThreadYield'
import { layoutPoolSitters, type ForestPoolPose } from './worldsForestLayout'
import type { WorldMapEntry } from './worldsCatalog'

const SIT_EMOTE = '/avatar/emotes/sittingGround1.glb'
const SPAWN_PARALLEL = 8

type OccupantSlot = {
  key: string
  address: string
  worldName: string
  x: number
  z: number
  yaw: number
  placeholder?: boolean
}

type Occupant = {
  key: string
  root: THREE.Group
  mixer: THREE.AnimationMixer | null
  model: THREE.Object3D | null
  nameTagAnchor: THREE.Object3D
  nameTag: NameTag | null
  head: THREE.Bone | null
}

export class ForestPoolOccupants {
  private readonly scene: THREE.Scene
  private readonly byKey = new Map<string, Occupant>()
  private disposed = false
  private sitClipPromise: Promise<THREE.AnimationClip | null> | null = null
  private queue: OccupantSlot[] = []
  private spawning = false

  constructor(scene: THREE.Scene) {
    this.scene = scene
    void this.sitClip()
  }

  sync(pools: ForestPoolPose[], catalog: WorldMapEntry[]): void {
    if (this.disposed) return
    const wanted = planOccupants(pools, catalog)
    const wantedKeys = new Set(wanted.map((s) => s.key))
    for (const key of [...this.byKey.keys()]) {
      if (!wantedKeys.has(key)) this.remove(key)
    }
    for (const slot of wanted) {
      const live = this.byKey.get(slot.key)
      if (live) this.place(live, slot)
    }
    this.queue = wanted.filter((s) => !this.byKey.has(s.key))
    void this.drain()
  }

  update(dt: number): void {
    for (const o of this.byKey.values()) {
      o.mixer?.update(dt)
      if (o.model) updateNameTagAnchor(o.nameTagAnchor, o.model, 1.72, undefined, o.head)
    }
  }

  dispose(): void {
    this.disposed = true
    this.queue = []
    for (const key of [...this.byKey.keys()]) this.remove(key)
  }

  private async drain(): Promise<void> {
    if (this.spawning || this.disposed) return
    this.spawning = true
    try {
      while (this.queue.length && !this.disposed) {
        const batch: OccupantSlot[] = []
        while (batch.length < SPAWN_PARALLEL && this.queue.length) {
          const slot = this.queue.shift()
          if (!slot || this.byKey.has(slot.key)) continue
          batch.push(slot)
        }
        if (!batch.length) break
        await Promise.all(batch.map((slot) => this.spawn(slot)))
        if (this.queue.length) await yieldToNextFrame()
      }
    } finally {
      this.spawning = false
    }
  }

  private async spawn(slot: OccupantSlot): Promise<void> {
    if (this.disposed || this.byKey.has(slot.key)) return
    const root = new THREE.Group()
    root.name = `forest-occupant-${slot.address.slice(0, 8)}`
    const nameTagAnchor = new THREE.Object3D()
    nameTagAnchor.name = 'forest-occupant-name-tag'
    nameTagAnchor.position.set(0, 2.2, 0)
    root.add(nameTagAnchor)
    const rec: Occupant = {
      key: slot.key,
      root,
      mixer: null,
      model: null,
      nameTagAnchor,
      nameTag: null,
      head: null
    }
    this.place(rec, slot)
    this.scene.add(root)
    this.byKey.set(slot.key, rec)

    if (!slot.placeholder) {
      rec.nameTag = NameTag.attach(nameTagAnchor, shortenAddress(slot.address), {
        textColor: '#ffffff',
        claimed: false,
        address: slot.address
      })
    }

    try {
      const profile = slot.placeholder
        ? await resolveAvatarProfile(undefined)
        : await resolveAvatarProfile(slot.address)
      if (this.disposed || !this.byKey.has(slot.key)) return
      if (!slot.placeholder) {
        const identity = identityFromAvatarProfile(profile, slot.address)
        rec.nameTag?.setText(identity.displayName)
        rec.nameTag?.setStyle({
          textColor: identity.nameColor || '#ffffff',
          claimed: identity.hasClaimedName
        })
      }
      const model = await composeAvatarFromProfile(profile, undefined, getSessionAssetCache())
      if (this.disposed || !this.byKey.has(slot.key)) {
        disposeWearableInstance(model)
        return
      }
      const pivot = new THREE.Group()
      pivot.add(model)
      applyAvatarPivotOffset(pivot, model)
      root.add(pivot)
      pivot.rotation.y = AVATAR_YAW_OFFSET

      rec.model = model
      rec.head = findHeadBone(model)
      updateNameTagAnchor(nameTagAnchor, model, 1.72, undefined, rec.head)

      const clip = await this.sitClip()
      if (clip) {
        const remapped = remapClipToAvatar(clip, model)
        if (remapped) {
          rec.mixer = new THREE.AnimationMixer(model)
          const action = rec.mixer.clipAction(remapped)
          action.setLoop(THREE.LoopRepeat, Infinity)
          action.play()
        }
      }
    } catch (err) {
      console.warn('[forest] occupant compose failed', slot.address, err)
      if (this.disposed || !this.byKey.has(slot.key)) return
      const standin = new THREE.Mesh(
        new THREE.CapsuleGeometry(0.22, 0.95, 4, 10),
        new THREE.MeshStandardMaterial({ color: 0xb8a8d0, roughness: 0.72, metalness: 0.04 })
      )
      standin.position.y = 0.72
      rec.root.add(standin)
      rec.model = standin
    }
  }

  private async sitClip(): Promise<THREE.AnimationClip | null> {
    if (!this.sitClipPromise) {
      this.sitClipPromise = (async () => {
        try {
          const gltf = await createGltfLoader({}).loadAsync(SIT_EMOTE)
          return gltf.animations[0] ?? null
        } catch (err) {
          console.warn('[forest] sitting emote failed', err)
          return null
        }
      })()
    }
    return this.sitClipPromise
  }

  private place(o: Occupant, slot: OccupantSlot): void {
    o.root.position.set(slot.x, 0, slot.z)
    o.root.rotation.y = slot.yaw
  }

  private remove(key: string): void {
    const o = this.byKey.get(key)
    if (!o) return
    this.byKey.delete(key)
    o.mixer?.stopAllAction()
    o.nameTag?.dispose()
    disposeWearableInstance(o.root)
    o.root.removeFromParent()
  }
}

function planOccupants(pools: ForestPoolPose[], catalog: WorldMapEntry[]): OccupantSlot[] {
  const byWorld = new Map(catalog.map((e) => [e.worldName.toLowerCase(), e] as const))
  const occupied = [...pools].filter((p) => p.users > 0).sort((a, b) => a.rank - b.rank)
  const out: OccupantSlot[] = []
  for (const pool of occupied) {
    const entry = byWorld.get(pool.worldName.toLowerCase())
    const addrs = entry?.connectedAddresses ?? []
    if (!addrs.length) continue
    const poses = layoutPoolSitters(pool, addrs.length)
    for (let i = 0; i < addrs.length; i++) {
      const pose = poses[i]
      const address = addrs[i]
      if (!pose || !address) continue
      out.push({
        key: `${pool.worldName.toLowerCase()}:${address}`,
        address,
        worldName: pool.worldName,
        x: pose.x,
        z: pose.z,
        yaw: pose.yaw
      })
    }
  }
  return out
}
