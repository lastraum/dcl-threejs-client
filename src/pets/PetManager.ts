import * as THREE from 'three'
import {
  dclToThreePos,
  dclYawToThreeYaw,
  threeToDclPos,
  threeYawToDclYaw
} from '../bridge/dclTransform'
import {
  PET_AFK_IDLE_MS,
  PET_CATEGORY_CONFIG,
  PET_IDLE_SPEED,
  PET_SIT_IDLE_MS
} from './petCategories'
import { ensureBuiltinPetBytes, getBuiltinPet, isBuiltinPetHash } from './builtinPets'
import { getActivePetEntry, getPetInventory, setActivePetHash } from './petInventoryStorage'
import { loadPetLibraryBytes } from './PetLibrary'
import { PetFollow } from './PetFollow'
import { PetInstance } from './PetInstance'
import type { PetPeerSync } from './PetPeerSync'
import type { ActivePetSpec, PetAnimClipMap, PetCategory, PetPose } from './types'

const _dcl = new THREE.Vector3()
const _three = new THREE.Vector3()

const CULL_M2 = 64 * 64
const POSE_FOLLOW_RATE = 12

type RemotePet = {
  instance: PetInstance
  category: PetCategory
  /** Desired equip hash from DPET Announce (may differ from loaded mesh mid-switch). */
  contentHash: string
  /** Hash currently loaded into `instance` — null until first successful mesh load. */
  loadedHash: string | null
  meshYawOffsetDeg: number
  target: PetPose | null
  current: PetPose | null
}

/**
 * Local + remote pet roots. Network is DPET over RFC4 (PetPeerSync), not scene CRDT.
 */
export class PetManager {
  private scene: THREE.Scene | null = null
  private peerSync: PetPeerSync | null = null
  private localWallet: string | null = null
  private localInstance: PetInstance | null = null
  private localFollow = new PetFollow()
  private localSpec: ActivePetSpec | null = null
  private localPose: PetPose | null = null
  private readonly remotes = new Map<string, RemotePet>()
  /** Pose packets that arrived before announce/create. */
  private readonly pendingRemotePoses = new Map<string, PetPose>()
  private disposed = false
  private timeSec = 0
  /** Last wall-clock when owner moved above idle speed — AFK after PET_AFK_IDLE_MS. */
  private lastOwnerMoveMs = performance.now()
  /** Off-screen instance for settings clip preview when pet is not equipped. */
  private editPreview: PetInstance | null = null
  private editPreviewHash: string | null = null
  private readonly raycaster = new THREE.Raycaster()
  private readonly ndc = new THREE.Vector2()
  private readonly ownerFeet = new THREE.Vector3()
  private readonly localPlayerPos = new THREE.Vector3()
  /** Optional: seed remote pet near peer avatar until first DPET pose. */
  private peerFeetProvider: ((address: string) => THREE.Vector3 | null) | null = null

  bindScene(scene: THREE.Scene): void {
    this.scene = scene
    if (this.localInstance && this.localInstance.root.parent !== scene) {
      scene.add(this.localInstance.root)
    }
    for (const remote of this.remotes.values()) {
      if (remote.instance.root.parent !== scene) scene.add(remote.instance.root)
    }
  }

  unbindScene(): void {
    this.localInstance?.root.removeFromParent()
    for (const remote of this.remotes.values()) {
      remote.instance.root.removeFromParent()
    }
    this.scene = null
  }

  attachPeerSync(sync: PetPeerSync): void {
    this.peerSync = sync
  }

  /** Three-space feet of a remote peer — used until first pet pose arrives. */
  setPeerFeetProvider(provider: ((address: string) => THREE.Vector3 | null) | null): void {
    this.peerFeetProvider = provider
  }

  setLocalWallet(address: string | null): void {
    const next = address?.toLowerCase() ?? null
    const prev = this.localWallet
    this.localWallet = next
    // If a self-echo remote pet was created before wallet was known, drop it.
    if (next && next !== prev) {
      this.removeRemote(next)
      this.pendingRemotePoses.delete(next)
    }
  }

  getLocalSpec(): ActivePetSpec | null {
    return this.localSpec
  }

  getLocalPose(): PetPose | null {
    return this.localPose
  }

  /** Restore active pet from inventory after wallet / scene ready (survives /goto). */
  async restoreFromInventory(address?: string | null): Promise<void> {
    if (this.disposed) return
    const wallet = address ?? this.localWallet
    if (wallet) this.localWallet = wallet.toLowerCase()
    const entry = getActivePetEntry(wallet)
    if (!entry) {
      // No equipped pet. If we had a live mesh, tell peers (panel Disable sets
      // activeHash=null then restore — must DPET Clear, not silently despawn).
      // Cold start with nothing equipped: no Clear spam.
      const hadLive = !!(this.localSpec || this.localInstance)
      await this.despawnLocal({ clearEquip: false, announceClear: hadLive })
      return
    }
    try {
      await this.enableLocal({
        contentHash: entry.contentHash,
        category: entry.category,
        nickname: entry.nickname,
        fileName: entry.fileName,
        meshYawOffsetDeg: entry.meshYawOffsetDeg ?? 0,
        animClipMap: entry.animClipMap
      })
    } catch (err) {
      console.warn('[pets] restoreFromInventory failed', err)
    }
  }

  async enableLocal(spec: ActivePetSpec): Promise<void> {
    if (this.disposed) return
    const hash = spec.contentHash.toLowerCase()
    let bytes = await loadPetLibraryBytes(hash)
    // Built-ins ship in public/ — rehydrate from the bundle when IDB was wiped
    // but localStorage still has the pet equipped (quota / private mode / clear).
    if (!bytes && isBuiltinPetHash(hash)) {
      await ensureBuiltinPetBytes(hash)
      bytes = await loadPetLibraryBytes(hash)
    }
    if (!bytes) throw new Error('Pet model not found in library')

    if (this.localWallet) setActivePetHash(this.localWallet, hash)
    this.disposeEditPreview()

    if (!this.localInstance) {
      this.localInstance = new PetInstance()
      this.scene?.add(this.localInstance.root)
    } else if (this.scene && this.localInstance.root.parent !== this.scene) {
      this.scene.add(this.localInstance.root)
    }
    const builtin = getBuiltinPet(hash)
    const meshYaw = spec.meshYawOffsetDeg ?? builtin?.meshYawOffsetDeg ?? 0
    const animClipMap = spec.animClipMap ?? builtin?.animClipMap
    this.localSpec = {
      ...spec,
      contentHash: hash,
      meshYawOffsetDeg: meshYaw,
      animClipMap
    }
    this.localFollow.reset()
    this.lastOwnerMoveMs = performance.now()
    this.localInstance.setMeshYawOffsetDeg(meshYaw)
    this.localInstance.setAnimClipMap(animClipMap)
    await this.localInstance.loadFromBytes(bytes, spec.category)
    this.localInstance.setMeshYawOffsetDeg(meshYaw)
    this.localInstance.setAnimClipMap(animClipMap)
    await this.peerSync?.setLocalEquipped(hash, spec.category, {
      force: true,
      meshYawOffsetDeg: meshYaw
    })
  }

  /** Apply updated anim clip map to live local pet (settings save). */
  setLocalAnimClipMap(map: PetAnimClipMap | null | undefined): void {
    if (this.localSpec) {
      this.localSpec = { ...this.localSpec, animClipMap: map ?? undefined }
    }
    this.localInstance?.setAnimClipMap(map)
  }

  /**
   * Settings-panel clip preview.
   * Prefer the live equipped mesh (visible). Otherwise mount a temporary mesh
   * at the owner's feet so the animation is actually on-screen.
   */
  async playClipPreview(contentHash: string, clipName: string): Promise<boolean> {
    const hash = contentHash.toLowerCase()
    // Equipped pet — take over its mixer lock.
    if (this.localSpec?.contentHash === hash && this.localInstance?.isReady) {
      this.hideEditPreview()
      const ok = this.localInstance.playClipPreview(clipName)
      if (ok) console.info(`[pets] preview · equipped “${clipName}”`)
      return ok
    }
    const inst = await this.ensureEditPreview(hash)
    if (!inst) return false
    // Place next to player so the user can see the track (not an off-scene mixer).
    this.placeEditPreviewNearOwner(inst)
    const ok = inst.playClipPreview(clipName)
    if (ok) console.info(`[pets] preview · temp mesh “${clipName}”`)
    return ok
  }

  stopClipPreview(): void {
    this.localInstance?.stopClipPreview()
    this.editPreview?.stopClipPreview()
    this.hideEditPreview()
  }

  private placeEditPreviewNearOwner(inst: PetInstance): void {
    if (!this.scene) return
    if (inst.root.parent !== this.scene) this.scene.add(inst.root)
    const feet = this.ownerFeet
    const yaw = this.localPose?.yaw ?? 0
    // Slightly to the side of the owner so it doesn't clip the avatar.
    const side = 0.9
    inst.root.position.set(
      feet.x + Math.sin(yaw) * side,
      feet.y + 0.05,
      feet.z + Math.cos(yaw) * side
    )
    inst.root.rotation.set(0, yaw, 0)
    inst.root.visible = true
  }

  private hideEditPreview(): void {
    if (!this.editPreview) return
    this.editPreview.root.visible = false
    this.editPreview.root.removeFromParent()
  }

  private async ensureEditPreview(hash: string): Promise<PetInstance | null> {
    if (this.editPreview && this.editPreviewHash === hash && this.editPreview.isReady) {
      return this.editPreview
    }
    this.disposeEditPreview()
    const entry = getActivePetEntry(this.localWallet)
    const owned = getPetInventory(this.localWallet).owned.find((e) => e.contentHash === hash)
    const builtin = getBuiltinPet(hash)
    const category =
      entry?.contentHash === hash
        ? entry.category
        : owned?.category ?? builtin?.category ?? 'walking'
    let bytes = await loadPetLibraryBytes(hash)
    if (!bytes && isBuiltinPetHash(hash)) {
      await ensureBuiltinPetBytes(hash)
      bytes = await loadPetLibraryBytes(hash)
    }
    if (!bytes || this.disposed) return null
    const inst = new PetInstance()
    await inst.loadFromBytes(bytes, category)
    const map = owned?.animClipMap ?? builtin?.animClipMap
    inst.setAnimClipMap(map)
    const yaw = owned?.meshYawOffsetDeg ?? builtin?.meshYawOffsetDeg ?? 0
    inst.setMeshYawOffsetDeg(yaw)
    this.editPreview = inst
    this.editPreviewHash = hash
    return inst
  }

  private disposeEditPreview(): void {
    this.editPreview?.dispose()
    this.editPreview = null
    this.editPreviewHash = null
  }

  /**
   * User disable — clears equipped hash in localStorage.
   * World teardown must use despawnLocal({ clearEquip: false }) so /goto keeps the pet.
   */
  async disableLocal(): Promise<void> {
    await this.despawnLocal({ clearEquip: true, announceClear: true })
  }

  /**
   * Drop the live mesh / peer announce without necessarily clearing inventory equip.
   * @param clearEquip when true, marks no active pet in localStorage (user Disable).
   * @param announceClear when true, send DPET Clear to peers.
   */
  async despawnLocal(opts?: { clearEquip?: boolean; announceClear?: boolean }): Promise<void> {
    const clearEquip = opts?.clearEquip === true
    const announceClear = opts?.announceClear !== false
    if (clearEquip && this.localWallet) setActivePetHash(this.localWallet, null)
    this.localSpec = null
    this.localPose = null
    this.localFollow.reset()
    this.localInstance?.dispose()
    this.localInstance = null
    if (announceClear) {
      await this.peerSync?.setLocalEquipped(null, 'walking', { force: true })
    }
  }

  async setLocalCategory(category: PetCategory): Promise<void> {
    if (!this.localSpec || !this.localInstance) return
    this.localSpec = { ...this.localSpec, category }
    this.localInstance.setCategory(category)
    await this.peerSync?.setLocalEquipped(this.localSpec.contentHash, category, {
      force: true,
      meshYawOffsetDeg: this.localSpec.meshYawOffsetDeg ?? 0
    })
  }

  /** Live update mesh export fix without full reload. */
  setLocalMeshYawOffsetDeg(deg: number): void {
    if (!this.localSpec || !this.localInstance) return
    this.localSpec = { ...this.localSpec, meshYawOffsetDeg: deg }
    this.localInstance.setMeshYawOffsetDeg(deg)
    void this.peerSync?.setLocalEquipped(this.localSpec.contentHash, this.localSpec.category, {
      force: true,
      meshYawOffsetDeg: deg
    })
  }

  onPeerPetChanged(
    address: string,
    contentHash: string | null,
    category: PetCategory | null,
    meshYawOffsetDeg = 0
  ): void {
    const key = address.toLowerCase()
    // Never mount a "remote" for the local wallet (self-echo / late localAddress).
    if (this.localWallet && key === this.localWallet) {
      this.removeRemote(key)
      this.pendingRemotePoses.delete(key)
      return
    }
    if (!contentHash) {
      this.removeRemote(key)
      this.pendingRemotePoses.delete(key)
      return
    }
    let remote = this.remotes.get(key)
    if (!remote) {
      const instance = new PetInstance()
      this.scene?.add(instance.root)
      remote = {
        instance,
        category: category ?? 'walking',
        contentHash,
        loadedHash: null,
        meshYawOffsetDeg,
        target: null,
        current: null
      }
      this.remotes.set(key, remote)
      instance.setMeshYawOffsetDeg(meshYawOffsetDeg)
      // Place near peer avatar until first pose (otherwise sits at world origin).
      this.seedRemoteNearPeer(key, remote)
      const pending = this.pendingRemotePoses.get(key)
      if (pending) {
        remote.target = { ...pending }
        remote.current = { ...pending }
        this.pendingRemotePoses.delete(key)
      }
    } else {
      // Same desired hash re-announce — only refresh yaw/category.
      const sameDesired = remote.contentHash === contentHash
      remote.contentHash = contentHash
      remote.category = category ?? remote.category
      remote.meshYawOffsetDeg = meshYawOffsetDeg
      remote.instance.setMeshYawOffsetDeg(meshYawOffsetDeg)
      if (!sameDesired) {
        // Equip switch: mesh is still the old pet until bytes load — must remount.
        remote.loadedHash = null
        remote.instance.root.visible = false
      }
    }
  }

  async onPeerPetBytesReady(
    address: string,
    contentHash: string,
    category: PetCategory,
    meshYawOffsetDeg = 0
  ): Promise<void> {
    const key = address.toLowerCase()
    if (this.localWallet && key === this.localWallet) return
    let remote = this.remotes.get(key)
    if (!remote) {
      this.onPeerPetChanged(key, contentHash, category, meshYawOffsetDeg)
      remote = this.remotes.get(key)
      if (!remote) return
    }
    // Skip only when this exact mesh is already mounted (WantAnnounce rebroadcast).
    // Do NOT use contentHash alone — equip switch sets contentHash before load, and
    // isReady stays true on the *old* mesh, which left remotes stuck on pet A.
    if (
      remote.instance.isReady &&
      remote.loadedHash === contentHash &&
      remote.category === category
    ) {
      remote.meshYawOffsetDeg = meshYawOffsetDeg
      remote.instance.setMeshYawOffsetDeg(meshYawOffsetDeg)
      remote.instance.root.visible = true
      if (!remote.target) this.seedRemoteNearPeer(key, remote)
      return
    }
    // Never remount a peer with a hash they are not currently announced for
    // (stale dual-room DPET streams used to turn every remote into the local pet).
    const announced = this.peerSync?.getPeerEquippedHash(key)
    if (announced && announced !== contentHash) {
      console.info(
        `[pets] skip stale bytes · ${key.slice(0, 10)}… got ${contentHash.slice(0, 12)}… want ${announced.slice(0, 12)}…`
      )
      return
    }
    remote.category = category
    remote.contentHash = contentHash
    remote.meshYawOffsetDeg = meshYawOffsetDeg
    const bytes = await loadPetLibraryBytes(contentHash)
    if (!bytes || this.disposed) return
    // Stale completion after hash change / clear.
    if (this.remotes.get(key)?.contentHash !== contentHash) return
    const stillAnnounced = this.peerSync?.getPeerEquippedHash(key)
    if (stillAnnounced && stillAnnounced !== contentHash) return
    remote.instance.setMeshYawOffsetDeg(meshYawOffsetDeg)
    await remote.instance.loadFromBytes(bytes, category)
    // Another equip may have won while parse ran.
    if (this.remotes.get(key)?.contentHash !== contentHash) return
    remote.loadedHash = contentHash
    remote.instance.setMeshYawOffsetDeg(meshYawOffsetDeg)
    remote.instance.root.visible = true
    if (!remote.target) this.seedRemoteNearPeer(key, remote)
    console.info(`[pets] remote mesh ready · ${key.slice(0, 10)}… ${contentHash.slice(0, 12)}…`)
  }

  onPeerPetPose(address: string, pose: PetPose): void {
    const key = address.toLowerCase()
    if (this.localWallet && key === this.localWallet) return
    const remote = this.remotes.get(key)
    if (!remote) {
      // Announce may lag pose by a frame or two — buffer.
      this.pendingRemotePoses.set(key, { ...pose })
      return
    }
    remote.target = { ...pose }
    if (!remote.current) remote.current = { ...pose }
  }

  /** Scene-local Three feet of the owner peer → provisional pet pose (DCL wire space). */
  private seedRemoteNearPeer(address: string, remote: RemotePet): void {
    const feet = this.peerFeetProvider?.(address)
    if (!feet) return
    threeToDclPos(feet.x, feet.y + (remote.category === 'flying' ? 1.6 : 0.05), feet.z, _dcl)
    const pose: PetPose = {
      x: _dcl.x,
      y: _dcl.y,
      z: _dcl.z,
      yaw: 0,
      horizontalSpeed: 0,
      anim: 'idle'
    }
    if (!remote.target) remote.target = { ...pose }
    if (!remote.current) remote.current = { ...pose }
  }

  removeRemote(address: string): void {
    const key = address.toLowerCase()
    const remote = this.remotes.get(key)
    if (!remote) return
    remote.instance.dispose()
    this.remotes.delete(key)
  }

  /**
   * @param ownerFeetThree Owner feet in Three world space
   * @param ownerYawThree Owner yaw in Three space
   * @param ownerHorizontalSpeed m/s
   * @param localPlayerThree Local player feet for remote cull
   */
  updateLocal(
    dt: number,
    ownerFeetThree: THREE.Vector3,
    ownerYawThree: number,
    ownerHorizontalSpeed: number
  ): PetPose | null {
    this.timeSec += dt
    this.ownerFeet.copy(ownerFeetThree)
    // Temp settings-preview mesh (non-equipped pet) — keep mixer running + beside player.
    if (this.editPreview?.isPreviewLocked()) {
      this.placeEditPreviewNearOwner(this.editPreview)
      this.editPreview.update(dt)
    } else if (this.editPreview) {
      this.editPreview.update(dt)
    }
    if (!this.localInstance || !this.localSpec) {
      this.localPose = null
      return null
    }

    const now = performance.now()
    if (ownerHorizontalSpeed >= PET_IDLE_SPEED) {
      this.lastOwnerMoveMs = now
    }

    // Follow works in Three space (matches render + owner feet root).
    const pose = this.localFollow.tick({
      ownerFeet: this.ownerFeet,
      ownerYaw: ownerYawThree,
      ownerHorizontalSpeed,
      category: this.localSpec.category,
      dt,
      timeSec: this.timeSec
    })
    // Rest bands: owner idle ≥25s → sit, ≥5 min → AFK (if any clips resolve).
    // Gated on the pet itself having settled, so it never plays a seated clip
    // while still sliding into its follow slot.
    if (pose.anim === 'idle' && !this.localInstance.isPreviewLocked()) {
      const ownerIdleMs = now - this.lastOwnerMoveMs
      if (ownerIdleMs >= PET_AFK_IDLE_MS) pose.anim = 'afk'
      else if (ownerIdleMs >= PET_SIT_IDLE_MS) pose.anim = 'sit'
    }
    // While preview is locked, still update leash transform but not loco clip.
    this.localInstance.applyPose(pose)
    this.localInstance.update(dt)
    this.localPose = pose

    // Broadcast base Y (no bob) so remotes can bob smoothly in local sim.
    if (this.peerSync) {
      const bob = this.localFollow.lastBob
      threeToDclPos(pose.x, pose.y - bob, pose.z, _dcl)
      this.peerSync.maybeBroadcastPose({
        x: _dcl.x,
        y: _dcl.y,
        z: _dcl.z,
        yaw: threeYawToDclYaw(pose.yaw),
        horizontalSpeed: pose.horizontalSpeed,
        anim: pose.anim
      })
    }
    return pose
  }

  /** Force a pose packet now (e.g. after equip). */
  flushLocalPose(): void {
    if (!this.localPose || !this.peerSync) return
    const bob = this.localFollow.lastBob
    threeToDclPos(this.localPose.x, this.localPose.y - bob, this.localPose.z, _dcl)
    this.peerSync.forceBroadcastPose({
      x: _dcl.x,
      y: _dcl.y,
      z: _dcl.z,
      yaw: threeYawToDclYaw(this.localPose.yaw),
      horizontalSpeed: this.localPose.horizontalSpeed,
      anim: this.localPose.anim
    })
  }

  updateRemotes(dt: number, localPlayerThree: THREE.Vector3): void {
    this.localPlayerPos.copy(localPlayerThree)
    for (const remote of this.remotes.values()) {
      if (!remote.target) {
        remote.instance.update(dt)
        continue
      }

      // Incoming pose is DCL meters / DCL yaw → Three for display (base Y, no bob).
      dclToThreePos(remote.target.x, remote.target.y, remote.target.z, _three)
      const targetPose: PetPose = {
        ...remote.target,
        x: _three.x,
        y: _three.y,
        z: _three.z,
        yaw: dclYawToThreeYaw(remote.target.yaw)
      }

      if (!remote.current) {
        remote.current = { ...targetPose }
      } else {
        const t = 1 - Math.exp(-POSE_FOLLOW_RATE * dt)
        remote.current.x += (targetPose.x - remote.current.x) * t
        remote.current.y += (targetPose.y - remote.current.y) * t
        remote.current.z += (targetPose.z - remote.current.z) * t
        remote.current.yaw = dampAngle(remote.current.yaw, targetPose.yaw, 10, dt)
        remote.current.horizontalSpeed = targetPose.horizontalSpeed
        remote.current.anim = targetPose.anim
      }

      // Local bob for flying — smooth at full frame rate, not pose packet rate.
      let displayY = remote.current.y
      if (remote.category === 'flying') {
        const cfg = PET_CATEGORY_CONFIG.flying
        if (cfg.bobAmplitude > 0 && cfg.bobHz > 0) {
          displayY +=
            Math.sin(this.timeSec * cfg.bobHz * Math.PI * 2) * cfg.bobAmplitude
        }
      }

      const dx = remote.current.x - this.localPlayerPos.x
      const dz = remote.current.z - this.localPlayerPos.z
      const far = dx * dx + dz * dz > CULL_M2
      remote.instance.root.visible = !far && remote.instance.isReady
      if (!far) {
        remote.instance.applyPose({ ...remote.current, y: displayY })
        remote.instance.update(dt)
      }
    }
  }

  /** Right-click / pick: returns owner address or 'local'. */
  pickAtPointer(
    clientX: number,
    clientY: number,
    camera: THREE.Camera,
    canvas: HTMLElement
  ): { kind: 'local' | 'remote'; address?: string } | null {
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    this.ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1
    this.ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1
    this.raycaster.setFromCamera(this.ndc, camera)

    const targets: { obj: THREE.Object3D; hit: { kind: 'local' | 'remote'; address?: string } }[] =
      []
    if (this.localInstance?.isReady) {
      targets.push({ obj: this.localInstance.root, hit: { kind: 'local' } })
    }
    for (const [addr, remote] of this.remotes) {
      if (remote.instance.isReady) {
        targets.push({ obj: remote.instance.root, hit: { kind: 'remote', address: addr } })
      }
    }
    if (!targets.length) return null

    let best: { dist: number; hit: { kind: 'local' | 'remote'; address?: string } } | null = null
    for (const t of targets) {
      const hits = this.raycaster.intersectObject(t.obj, true)
      if (hits[0] && (!best || hits[0].distance < best.dist)) {
        best = { dist: hits[0].distance, hit: t.hit }
      }
    }
    return best?.hit ?? null
  }

  /** Inventory still lists pets even if equip not loaded — for panel. */
  listOwnedFromStorage(address?: string | null): ReturnType<typeof getPetInventory> {
    return getPetInventory(address ?? this.localWallet)
  }

  dispose(): void {
    this.disposed = true
    this.disposeEditPreview()
    // Keep activeHash in localStorage so the next World can restore after /goto.
    void this.despawnLocal({ clearEquip: false, announceClear: true })
    for (const key of [...this.remotes.keys()]) this.removeRemote(key)
    this.scene = null
    this.peerSync = null
  }
}

function dampAngle(current: number, target: number, rate: number, dt: number): number {
  let diff = target - current
  while (diff > Math.PI) diff -= Math.PI * 2
  while (diff < -Math.PI) diff += Math.PI * 2
  return current + diff * (1 - Math.exp(-rate * dt))
}
