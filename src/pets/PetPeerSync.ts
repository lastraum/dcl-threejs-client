/**
 * P2P pet equip + pose over DPET (RFC4 scene `dcl.client.pet`).
 * Asset path mirrors DAV/VrmPeerSync; pose is local-authoritative on owner.
 */
import type { CommsService } from '../network/CommsService'
import {
  DpetMessageType,
  encodeDpetAnnounce,
  encodeDpetClear,
  encodeDpetEnvelopes,
  encodeDpetFetchError,
  encodeDpetFetchRequest,
  encodeDpetGlbChunkStream,
  encodeDpetPose,
  encodeDpetWantAnnounce,
  tryDecodeDpetMessage
} from './dclClientPet'
import { ensureBuiltinPetBytes, isBuiltinPetHash } from './builtinPets'
import { PET_MAX_BYTES } from './constants'
import { sha256Hex } from '../avatar/vrm/vrmHash'
import {
  cacheRemotePetBytes,
  getPetLibraryEntry,
  invalidatePetLibraryBytes,
  loadPetLibraryBytes
} from './PetLibrary'
import type { PetCategory, PetPose } from './types'

export type PetPeerSyncCallbacks = {
  onPeerPetChanged: (
    address: string,
    contentHash: string | null,
    category: PetCategory | null,
    meshYawOffsetDeg?: number
  ) => void
  onPeerPetBytesReady: (
    address: string,
    contentHash: string,
    category: PetCategory,
    meshYawOffsetDeg?: number
  ) => void
  onPeerPetPose: (address: string, pose: PetPose) => void
}

type IncomingFetch = {
  provider: string
  hash: string
  totalSize: number
  chunks: Map<number, Uint8Array>
  receivedBytes: number
  startedAt: number
  category: PetCategory
  /** Bumps on each FetchBegin / force restart so late chunks from old serves are ignored. */
  generation: number
}

const FETCH_TIMEOUT_MS = 120_000

export class PetPeerSync {
  private comms: CommsService | null = null
  private callbacks: PetPeerSyncCallbacks | null = null
  private localAddress: string | null = null
  private equippedHash: string | null = null
  private equippedCategory: PetCategory = 'walking'
  private equippedMeshYawDeg = 0
  private publishedHash: string | null | undefined = undefined
  private readonly peerHash = new Map<string, string | null>()
  private readonly peerCategory = new Map<string, PetCategory>()
  private readonly peerMeshYaw = new Map<string, number>()
  private readonly incomingFetches = new Map<string, IncomingFetch>()
  private readonly pendingRequests = new Set<string>()
  private readonly servingKeys = new Set<string>()
  private readonly fetchAttempts = new Map<string, number>()
  /** Last outbound fetch-request time per provider:hash — spam throttle. */
  private readonly lastFetchRequestAt = new Map<string, number>()
  /** Last time we began serving a requester (any hash). */
  private readonly lastServeAt = new Map<string, number>()
  private peerJoinReannounceTimer: ReturnType<typeof setTimeout> | null = null
  private loginRetryTimers: ReturnType<typeof setTimeout>[] = []
  private lastPoseSendMs = 0
  private loggedWantAnnounce = false
  /** Debounce rapid local equip/clear toggles into one wire publish. */
  private equipPublishTimer: ReturnType<typeof setTimeout> | null = null
  private pendingEquipPublish: {
    hash: string | null
    category: PetCategory
    meshYawOffsetDeg: number
    force: boolean
  } | null = null
  /** Bumps on clear / equip change — aborts in-flight multi‑MB serves. */
  private serveGeneration = 0
  private wantAnnounceReplyTimer: ReturnType<typeof setTimeout> | null = null

  private static readonly MAX_FETCH_ATTEMPTS = 4
  private static readonly PEER_JOIN_REANNOUNCE_MS = 400
  private static readonly POSE_MOVING_MS = 80
  private static readonly POSE_IDLE_MS = 800
  /** Coalesce rapid toggle → one Announce/Clear on the wire. */
  private static readonly EQUIP_PUBLISH_DEBOUNCE_MS = 280
  /** Min gap between fetch-requests for the same provider+hash. */
  private static readonly FETCH_REQUEST_MIN_MS = 2_500
  /** Min gap between serving the same requester (any hash). */
  private static readonly SERVE_MIN_MS = 1_200
  /** Max concurrent outbound serves (all requesters). */
  private static readonly MAX_CONCURRENT_SERVES = 2
  private static readonly WANT_ANNOUNCE_REPLY_MS = 200

  attach(comms: CommsService, callbacks: PetPeerSyncCallbacks): void {
    this.comms = comms
    this.callbacks = callbacks
    comms.setPetHandler((sender, data) => this.handlePacket(sender, data))
  }

  detach(): void {
    if (this.peerJoinReannounceTimer) {
      clearTimeout(this.peerJoinReannounceTimer)
      this.peerJoinReannounceTimer = null
    }
    if (this.equipPublishTimer) {
      clearTimeout(this.equipPublishTimer)
      this.equipPublishTimer = null
    }
    if (this.wantAnnounceReplyTimer) {
      clearTimeout(this.wantAnnounceReplyTimer)
      this.wantAnnounceReplyTimer = null
    }
    this.pendingEquipPublish = null
    this.serveGeneration++
    for (const t of this.loginRetryTimers) clearTimeout(t)
    this.loginRetryTimers = []
    this.comms?.setPetHandler(null)
    this.comms = null
    this.callbacks = null
    this.incomingFetches.clear()
    this.pendingRequests.clear()
    this.servingKeys.clear()
    this.fetchAttempts.clear()
    this.lastFetchRequestAt.clear()
    this.lastServeAt.clear()
  }

  setLocalAddress(address: string | null): void {
    const next = address?.toLowerCase() ?? null
    const prev = this.localAddress
    this.localAddress = next
    // Packets that arrived before wallet was known used to spawn a remote of self.
    if (next && next !== prev) {
      this.peerHash.delete(next)
      this.peerCategory.delete(next)
      this.peerMeshYaw.delete(next)
      this.callbacks?.onPeerPetChanged(next, null, null)
    }
  }

  getPeerEquippedHash(address: string): string | null {
    return this.peerHash.get(address.toLowerCase()) ?? null
  }

  getPeerCategory(address: string): PetCategory | null {
    return this.peerCategory.get(address.toLowerCase()) ?? null
  }

  getPeerMeshYawOffsetDeg(address: string): number {
    return this.peerMeshYaw.get(address.toLowerCase()) ?? 0
  }

  async setLocalEquipped(
    hash: string | null,
    category: PetCategory = 'walking',
    options?: { force?: boolean; meshYawOffsetDeg?: number }
  ): Promise<void> {
    const normalized = hash?.toLowerCase() ?? null
    const force = options?.force === true
    this.equippedHash = normalized
    this.equippedCategory = category
    if (options?.meshYawOffsetDeg != null) {
      this.equippedMeshYawDeg = options.meshYawOffsetDeg
    }

    // Abort any in-flight serve immediately when equip is cleared or swapped.
    this.serveGeneration++

    if (!normalized) {
      if (!force && this.publishedHash === null && !this.pendingEquipPublish) return
      // Debounce clear with announce so rapid toggle off→on does not spam Clear+Announce.
      this.queueEquipPublish({
        hash: null,
        category: 'walking',
        meshYawOffsetDeg: this.equippedMeshYawDeg,
        force
      })
      return
    }

    if (!force && this.publishedHash === normalized && !this.pendingEquipPublish) return

    const bytes = await loadPetLibraryBytes(normalized)
    if (!bytes) {
      console.warn('[pets] announce skipped — hash not in library', normalized.slice(0, 12))
      return
    }
    // User may have toggled off while we awaited IDB.
    if (this.equippedHash !== normalized) return
    const entry = await getPetLibraryEntry(normalized)
    if (this.equippedHash !== normalized) return
    this.equippedCategory = entry?.category ?? category
    if (options?.meshYawOffsetDeg == null && entry?.meshYawOffsetDeg != null) {
      this.equippedMeshYawDeg = entry.meshYawOffsetDeg
    }
    this.queueEquipPublish({
      hash: normalized,
      category: this.equippedCategory,
      meshYawOffsetDeg: this.equippedMeshYawDeg,
      force
    })
  }

  /**
   * Collapse rapid enable/disable into a single wire publish after a short quiet period.
   * Final state wins — peers never see intermediate spam.
   */
  private queueEquipPublish(next: {
    hash: string | null
    category: PetCategory
    meshYawOffsetDeg: number
    force: boolean
  }): void {
    this.pendingEquipPublish = next
    if (this.equipPublishTimer) clearTimeout(this.equipPublishTimer)
    // force (scene connect / peer join) still debounces slightly so a burst collapses.
    const delay = next.force ? 80 : PetPeerSync.EQUIP_PUBLISH_DEBOUNCE_MS
    this.equipPublishTimer = setTimeout(() => {
      this.equipPublishTimer = null
      const pending = this.pendingEquipPublish
      this.pendingEquipPublish = null
      if (!pending) return
      void this.flushEquipPublish(pending)
    }, delay)
  }

  private async flushEquipPublish(pending: {
    hash: string | null
    category: PetCategory
    meshYawOffsetDeg: number
    force: boolean
  }): Promise<void> {
    // Use live equip state (may have changed again after timer was set).
    const hash = this.equippedHash
    if (!hash) {
      if (this.publishedHash === null) return
      const sent = await this.publish(encodeDpetEnvelopes(encodeDpetClear()), 'clear')
      if (sent) {
        this.publishedHash = null
        console.info('[pets] DPET clear (equip off)')
      }
      return
    }
    if (!pending.force && this.publishedHash === hash) return
    const bytes = await loadPetLibraryBytes(hash)
    if (!bytes || this.equippedHash !== hash) return
    // Pet A → pet B: send Clear first so remotes drop A before mounting B.
    // Clear also aborts mid-fetch of the old hash when the owner swaps quickly.
    if (this.publishedHash && this.publishedHash !== hash) {
      const prev = this.publishedHash
      const cleared = await this.publish(encodeDpetEnvelopes(encodeDpetClear()), 'clear')
      if (cleared) {
        this.publishedHash = null
        console.info(
          `[pets] DPET clear (switch) · was ${prev.slice(0, 12)}… → ${hash.slice(0, 12)}…`
        )
      }
      // Brief gap so remotes process Clear before Announce (same reliable channel).
      await new Promise((r) => setTimeout(r, 40))
      if (this.equippedHash !== hash) return
    }
    await this.publishAnnounce(
      hash,
      bytes.byteLength,
      this.equippedCategory,
      this.equippedMeshYawDeg,
      true
    )
    this.lastPoseSendMs = 0
  }

  async onSceneConnected(): Promise<void> {
    this.publishedHash = undefined
    // Only re-announce when we already know equip. Never force DPET Clear here —
    // World may still be restoring inventory; Clear wiped remotes after a later Announce.
    if (this.equippedHash) {
      await this.setLocalEquipped(this.equippedHash, this.equippedCategory, {
        force: true,
        meshYawOffsetDeg: this.equippedMeshYawDeg
      })
    }
    void this.requestPeerAnnounces()
  }

  /** Probe peers for pet equip (late join / handoff). */
  async requestPeerAnnounces(): Promise<void> {
    const sent = await this.publish(encodeDpetEnvelopes(encodeDpetWantAnnounce()), 'want-announce')
    if (sent && !this.loggedWantAnnounce) {
      this.loggedWantAnnounce = true
      console.info('[pets] DPET WantAnnounce sent — asking peers to re-announce equip')
    }
  }

  /**
   * Delayed WantAnnounce + local re-announce + re-apply cached peer equips.
   * Mirrors VrmPeerSync — pets previously only announced once and remotes stayed invisible.
   */
  scheduleLoginWantAnnounceRetries(): void {
    for (const t of this.loginRetryTimers) clearTimeout(t)
    this.loginRetryTimers = []
    const delays = [500, 1500, 3500, 7000]
    for (const ms of delays) {
      this.loginRetryTimers.push(
        setTimeout(() => {
          if (!this.comms) return
          void this.requestPeerAnnounces()
          void this.reannounceEquipped()
          // Re-apply any peer equip we already heard (announce beat peer record / mesh fetch).
          if (this.callbacks) {
            for (const [address, hash] of this.peerHash) {
              if (!hash) continue
              const category = this.peerCategory.get(address) ?? 'walking'
              const yaw = this.peerMeshYaw.get(address) ?? 0
              this.callbacks.onPeerPetChanged(address, hash, category, yaw)
              void loadPetLibraryBytes(hash).then((bytes) => {
                if (bytes) {
                  this.callbacks?.onPeerPetBytesReady(address, hash, category, yaw)
                } else {
                  void this.requestPeerPet(address, hash, category, true)
                }
              })
            }
          }
        }, ms)
      )
    }
  }

  async onPeerJoined(_address: string): Promise<void> {
    if (!this.equippedHash) return
    if (this.peerJoinReannounceTimer) return
    this.peerJoinReannounceTimer = setTimeout(() => {
      this.peerJoinReannounceTimer = null
      void this.reannounceEquipped()
    }, PetPeerSync.PEER_JOIN_REANNOUNCE_MS)
  }

  onPeerLeave(address: string): void {
    const key = address.toLowerCase()
    this.peerHash.delete(key)
    this.peerCategory.delete(key)
    this.peerMeshYaw.delete(key)
    this.clearPeerFetchState(key)
    this.callbacks?.onPeerPetChanged(key, null, null)
  }

  /** Owner-side pose stream (throttled). Pose is scene-local DCL meters. */
  maybeBroadcastPose(pose: PetPose, nowMs: number = performance.now(), force = false): void {
    if (!this.equippedHash || !this.comms) return
    const moving = pose.horizontalSpeed > 0.15
    const interval = moving ? PetPeerSync.POSE_MOVING_MS : PetPeerSync.POSE_IDLE_MS
    if (!force && nowMs - this.lastPoseSendMs < interval) return
    this.lastPoseSendMs = nowMs
    void this.publish(encodeDpetEnvelopes(encodeDpetPose(pose)), 'pose')
  }

  /** Immediate pose after equip so late joiners don't wait for idle keepalive. */
  forceBroadcastPose(pose: PetPose): void {
    this.maybeBroadcastPose(pose, performance.now(), true)
  }

  gcStaleFetches(now = Date.now()): void {
    for (const [key, fetch] of this.incomingFetches) {
      if (now - fetch.startedAt > FETCH_TIMEOUT_MS) {
        this.incomingFetches.delete(key)
        this.pendingRequests.delete(`${fetch.provider}:${fetch.hash}`)
      }
    }
  }

  private async reannounceEquipped(): Promise<void> {
    if (!this.equippedHash) return
    const bytes = await loadPetLibraryBytes(this.equippedHash)
    if (!bytes) return
    // Always force — late joiners must hear equip even if we already announced.
    this.publishedHash = undefined
    await this.publishAnnounce(
      this.equippedHash,
      bytes.byteLength,
      this.equippedCategory,
      this.equippedMeshYawDeg,
      true
    )
  }

  private async publishAnnounce(
    hash: string,
    byteSize: number,
    category: PetCategory,
    meshYawOffsetDeg = 0,
    force = false
  ): Promise<void> {
    if (!force && this.publishedHash === hash) return
    const sent = await this.publish(
      encodeDpetEnvelopes(encodeDpetAnnounce(hash, byteSize, category, meshYawOffsetDeg)),
      'announce'
    )
    if (sent) {
      this.publishedHash = hash
      console.info(
        `[pets] DPET announce · ${category} ${hash.slice(0, 12)}… (${byteSize} B) yaw=${meshYawOffsetDeg}`
      )
    } else {
      console.warn('[pets] DPET announce failed — no LiveKit session?')
    }
  }

  private async publish(envelopes: Uint8Array[], kind: string): Promise<boolean> {
    if (!this.comms || !envelopes.length) return false
    // Announce / clear / want / pose / fetch-request → all rooms (owner may be island-only).
    // Chunk streams → primary only. Dual-room concurrent serves interleave FetchBegin/End
    // and remounted the wrong hash on remotes (toggling horse made every pet a horse).
    const roomMode =
      kind === 'announce' ||
      kind === 'clear' ||
      kind === 'want-announce' ||
      kind === 'pose' ||
      kind === 'fetch-request'
        ? 'broadcast'
        : 'primary'
    return this.comms.sendScenePet(envelopes, roomMode)
  }

  private handlePacket(sender: string, data: Uint8Array): void {
    const from = sender.toLowerCase()
    // Drop self-echoes (LiveKit can deliver our own broadcast). Without this we
    // spawn a second "remote" of the local pet on top of the real one.
    if (!from || (this.localAddress && from === this.localAddress)) return

    const msg = tryDecodeDpetMessage(data)
    if (!msg) return

    switch (msg.type) {
      case DpetMessageType.Announce:
        void this.onAnnounce(from, msg.hash, msg.byteSize, msg.category, msg.meshYawOffsetDeg)
        break
      case DpetMessageType.Clear:
        this.peerHash.set(from, null)
        this.peerCategory.delete(from)
        this.peerMeshYaw.delete(from)
        // Dump partial downloads — peer toggled off; re-enable will re-announce and
        // hit library cache if we already finished a prior transfer of that hash.
        this.clearPeerFetchState(from)
        this.callbacks?.onPeerPetChanged(from, null, null)
        break
      case DpetMessageType.WantAnnounce:
        // Coalesce many late joiners into one re-announce.
        this.scheduleWantAnnounceReply()
        break
      case DpetMessageType.FetchRequest:
        void this.serveFetch(from, msg.hash)
        break
      case DpetMessageType.FetchBegin: {
        // Only accept streams we asked for and that still match peer's announced equip.
        const h = msg.hash.toLowerCase()
        const reqKey = `${from}:${h}`
        const announced = this.peerHash.get(from)
        if (!announced || announced !== h) return
        if (!this.pendingRequests.has(reqKey)) return
        this.beginFetch(from, h, msg.totalSize, this.peerCategory.get(from), true)
        break
      }
      case DpetMessageType.FetchChunk:
        this.addChunk(from, msg.hash, msg.offset, msg.data)
        break
      case DpetMessageType.FetchEnd:
        void this.finishFetch(from, msg.hash)
        break
      case DpetMessageType.FetchError:
        this.pendingRequests.delete(`${from}:${msg.hash}`)
        // Soft retry after busy — do not stampede the server.
        if (msg.reason === 'busy' || msg.reason === 'not_found') {
          const cat = this.peerCategory.get(from) ?? 'walking'
          const want = this.peerHash.get(from)
          if (!want || want !== msg.hash.toLowerCase()) break
          window.setTimeout(() => {
            if (this.peerHash.get(from) !== msg.hash.toLowerCase()) return
            void this.requestPeerPet(from, msg.hash, cat, true)
          }, msg.reason === 'busy' ? 2_000 : 1_200)
        }
        break
      case DpetMessageType.Pose:
        this.callbacks?.onPeerPetPose(from, msg.pose)
        break
    }
  }

  private scheduleWantAnnounceReply(): void {
    if (!this.equippedHash) return
    if (this.wantAnnounceReplyTimer) return
    this.wantAnnounceReplyTimer = setTimeout(() => {
      this.wantAnnounceReplyTimer = null
      void this.reannounceEquipped()
    }, PetPeerSync.WANT_ANNOUNCE_REPLY_MS)
  }

  private async onAnnounce(
    from: string,
    hash: string,
    byteSize: number,
    category: PetCategory,
    meshYawOffsetDeg = 0
  ): Promise<void> {
    const h = hash.toLowerCase()
    const prev = this.peerHash.get(from)
    this.peerHash.set(from, h)
    this.peerCategory.set(from, category)
    this.peerMeshYaw.set(from, meshYawOffsetDeg)
    console.info(
      `[pets] DPET peer announce · ${from.slice(0, 10)}… ${category} ${h.slice(0, 12)}… (${byteSize} B)`
    )
    // Always re-apply — first announce often lands before remotes are tracked.
    this.callbacks?.onPeerPetChanged(from, h, category, meshYawOffsetDeg)

    if (byteSize > PET_MAX_BYTES) return

    // Same hash re-announce (toggle off→on or WantAnnounce): prefer local cache —
    // never re-pull multi‑MB if we already verified this hash.
    const existing = await loadPetLibraryBytes(h)
    // Peer may have cleared while we awaited IDB.
    if (this.peerHash.get(from) !== h) return
    if (existing) {
      try {
        // Size match is enough when re-enabling; full hash only when size differs.
        if (existing.byteLength === byteSize || prev === h) {
          if (existing.byteLength === byteSize) {
            const digest = await sha256Hex(existing)
            if (this.peerHash.get(from) !== h) return
            if (digest === h) {
              this.callbacks?.onPeerPetBytesReady(from, h, category, meshYawOffsetDeg)
              return
            }
            console.warn(
              `[pets] local cache hash mismatch for ${h.slice(0, 12)}… — re-fetch from peer`
            )
            await invalidatePetLibraryBytes(h)
          } else if (prev === h && existing.byteLength > 0) {
            // Re-equip same pet: trust verified library row even if wire size drifted.
            this.callbacks?.onPeerPetBytesReady(from, h, category, meshYawOffsetDeg)
            return
          }
        }
      } catch {
        await invalidatePetLibraryBytes(h)
      }
    }
    // New hash — cancel any partial for old hash on this peer.
    if (prev && prev !== h) this.clearPeerFetchState(from)
    void this.requestPeerPet(from, h, category, false)
  }

  /**
   * Re-apply cached peer equip after peer join (announce may have beaten onPeerJoin).
   * Mirrors VrmPeerSync.syncPeerToRemoteAvatars.
   */
  replayPeerEquip(address: string): void {
    const key = address.toLowerCase()
    const hash = this.peerHash.get(key)
    if (!hash) return
    const category = this.peerCategory.get(key) ?? 'walking'
    const yaw = this.peerMeshYaw.get(key) ?? 0
    this.callbacks?.onPeerPetChanged(key, hash, category, yaw)
    void loadPetLibraryBytes(hash).then((bytes) => {
      if (bytes) this.callbacks?.onPeerPetBytesReady(key, hash, category, yaw)
      else void this.requestPeerPet(key, hash, category, true)
    })
  }

  private async requestPeerPet(
    provider: string,
    hash: string,
    category: PetCategory,
    force = false
  ): Promise<void> {
    const p = provider.toLowerCase()
    const h = hash.toLowerCase()
    // Peer cleared or re-equipped something else — never chase stale hashes.
    if (this.peerHash.get(p) !== h) return

    // Built-in pets ship with every client — load from the bundle instead of
    // pulling megabytes off the owner's uplink. Hash is verified on fetch, so
    // the bytes are identical to what the owner would have sent.
    if (isBuiltinPetHash(h)) {
      const ready = await ensureBuiltinPetBytes(h)
      if (ready) {
        if (this.peerHash.get(p) !== h) return
        const yaw = this.peerMeshYaw.get(p) ?? 0
        this.callbacks?.onPeerPetBytesReady(p, h, category, yaw)
        return
      }
      // Bundle unreachable — fall through to the normal peer transfer.
    }

    // Already in library (toggle off→on after a prior complete transfer).
    const cached = await loadPetLibraryBytes(h)
    if (cached && this.peerHash.get(p) === h) {
      this.callbacks?.onPeerPetBytesReady(p, h, category, this.peerMeshYaw.get(p) ?? 0)
      return
    }
    if (this.peerHash.get(p) !== h) return

    const reqKey = `${p}:${h}`
    const fetchKey = `${p}:${h}`
    // In-flight assembly — do not stack concurrent requests (causes incomplete storms).
    const inflight = this.incomingFetches.get(fetchKey)
    if (inflight && inflight.totalSize > 0 && Date.now() - inflight.startedAt < 90_000) {
      if (!force) return
      // Only force-restart if the stream looks stuck (no progress for a while).
      if (Date.now() - inflight.startedAt < 12_000) return
    }
    if (!force && this.pendingRequests.has(reqKey)) return

    // Rate-limit spam from flaky incomplete retries / dual-room echoes.
    const now = Date.now()
    const lastReq = this.lastFetchRequestAt.get(reqKey) ?? 0
    if (!force && now - lastReq < PetPeerSync.FETCH_REQUEST_MIN_MS) return
    if (force && now - lastReq < 800) return

    if (force) {
      this.fetchAttempts.delete(reqKey)
      this.pendingRequests.delete(reqKey)
      this.incomingFetches.delete(fetchKey)
    }

    const attempts = (this.fetchAttempts.get(reqKey) ?? 0) + 1
    this.fetchAttempts.set(reqKey, attempts)
    if (attempts > PetPeerSync.MAX_FETCH_ATTEMPTS) {
      console.warn(`[pets] DPET fetch gave up · ${h.slice(0, 12)}… after ${attempts} tries`)
      return
    }
    this.pendingRequests.add(reqKey)
    this.lastFetchRequestAt.set(reqKey, now)
    // Placeholder until FetchBegin (generation 0 — Begin will reset cleanly).
    this.beginFetch(p, h, 0, category, true)
    console.info(
      `[pets] DPET fetch request · ${h.slice(0, 12)}… → ${p.slice(0, 10)}… (#${attempts})`
    )
    await this.publish(encodeDpetEnvelopes(encodeDpetFetchRequest(h)), 'fetch-request')
  }

  /**
   * @param reset when true (FetchBegin / force request), drop any prior partial chunks.
   */
  private beginFetch(
    provider: string,
    hash: string,
    totalSize: number,
    category?: PetCategory,
    reset = false
  ): void {
    const key = `${provider}:${hash}`
    const prev = reset ? undefined : this.incomingFetches.get(key)
    const generation = (prev?.generation ?? 0) + (reset || totalSize > 0 ? 1 : 0)
    this.incomingFetches.set(key, {
      provider,
      hash,
      totalSize: totalSize > 0 ? totalSize : prev?.totalSize || 0,
      chunks: reset || totalSize > 0 ? new Map() : (prev?.chunks ?? new Map()),
      receivedBytes: reset || totalSize > 0 ? 0 : (prev?.receivedBytes ?? 0),
      startedAt: Date.now(),
      category: category ?? prev?.category ?? this.peerCategory.get(provider) ?? 'walking',
      generation: generation || 1
    })
  }

  private addChunk(provider: string, hash: string, offset: number, data: Uint8Array): void {
    const key = `${provider}:${hash}`
    const fetch = this.incomingFetches.get(key)
    if (!fetch || fetch.totalSize <= 0) {
      // Chunk before Begin (or after reset) — ignore; next Begin starts clean.
      return
    }
    if (offset < 0 || offset >= fetch.totalSize) return
    // Mirror DAV: clamp oversize tails (legacy 4-byte pad made chunks 6004 on a 6000 stride).
    let chunk = data
    if (offset + chunk.byteLength > fetch.totalSize) {
      chunk = chunk.subarray(0, fetch.totalSize - offset)
    }
    if (chunk.byteLength <= 0) return
    if (fetch.chunks.has(offset)) return
    fetch.chunks.set(offset, chunk)
    fetch.receivedBytes += chunk.byteLength
    fetch.startedAt = Date.now() // progress heartbeat
  }

  private async finishFetch(provider: string, hash: string): Promise<void> {
    const key = `${provider}:${hash}`
    const fetch = this.incomingFetches.get(key)
    this.pendingRequests.delete(key)
    if (!fetch || fetch.totalSize <= 0) {
      this.incomingFetches.delete(key)
      return
    }

    // Assemble like DAV: write at offsets with clamp; require full coverage (no gaps).
    const out = new Uint8Array(fetch.totalSize)
    const covered = new Uint8Array(fetch.totalSize) // 1 = written
    let written = 0
    for (const [offset, chunk] of fetch.chunks) {
      if (offset < 0 || offset >= fetch.totalSize) continue
      const len = Math.min(chunk.byteLength, fetch.totalSize - offset)
      if (len <= 0) continue
      out.set(chunk.subarray(0, len), offset)
      for (let i = 0; i < len; i++) {
        if (covered[offset + i] === 0) {
          covered[offset + i] = 1
          written++
        }
      }
    }

    if (written < fetch.totalSize) {
      console.warn(
        `[pets] DPET incomplete · ${hash.slice(0, 12)}… covered ${written}/${fetch.totalSize} chunks=${fetch.chunks.size}`
      )
      this.incomingFetches.delete(key)
      // Only retry if peer still claims this hash (not cleared mid-transfer).
      window.setTimeout(() => {
        if (this.peerHash.get(provider) !== hash.toLowerCase()) return
        void this.requestPeerPet(provider, hash, fetch.category, true)
      }, 1_500)
      return
    }

    this.incomingFetches.delete(key)

    // Peer may have re-announced a different pet while this stream was in flight.
    const stillWanted = this.peerHash.get(provider)
    if (!stillWanted || stillWanted !== hash.toLowerCase()) {
      console.info(
        `[pets] DPET drop stale/cancelled stream · ${hash.slice(0, 12)}… peer=${stillWanted?.slice(0, 12) ?? 'off'}`
      )
      return
    }

    const exact = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength)
    try {
      const digest = await sha256Hex(exact)
      if (digest !== hash.toLowerCase()) {
        console.warn(
          `[pets] DPET hash mismatch · want ${hash.slice(0, 12)}… got ${digest.slice(0, 12)}… size=${exact.byteLength} — retry`
        )
        window.setTimeout(() => {
          if (this.peerHash.get(provider) !== hash.toLowerCase()) return
          void this.requestPeerPet(provider, hash, fetch.category, true)
        }, 1_500)
        return
      }
      const meshYaw = this.peerMeshYaw.get(provider) ?? 0
      await cacheRemotePetBytes(hash, exact, 'remote-pet.glb', fetch.category)
      console.info(`[pets] DPET fetch complete · ${hash.slice(0, 12)}… (${exact.byteLength} B)`)
      // Re-check after async cache — peer equip may have changed.
      if (this.peerHash.get(provider) !== hash.toLowerCase()) return
      this.fetchAttempts.delete(key)
      this.callbacks?.onPeerPetBytesReady(provider, hash, fetch.category, meshYaw)
    } catch (err) {
      console.warn('[pets] failed to cache remote pet', err)
    }
  }

  private async serveFetch(requester: string, hash: string): Promise<void> {
    const h = hash.toLowerCase()
    const req = requester.toLowerCase()
    // Only the owner of this equip should serve multi‑MB GLBs — never re-serve a
    // peer's pet we merely cached (that caused hash storms and wrong remounts).
    if (this.equippedHash !== h) {
      // Quiet not_found when we just cleared — avoid error spam during toggle.
      return
    }
    const serveKey = `${req}:${h}`
    if (this.servingKeys.has(serveKey)) return
    if (this.servingKeys.size >= PetPeerSync.MAX_CONCURRENT_SERVES) {
      await this.publish(encodeDpetEnvelopes(encodeDpetFetchError(h, 'busy')), 'fetch-error')
      return
    }
    const now = Date.now()
    const last = this.lastServeAt.get(req) ?? 0
    if (now - last < PetPeerSync.SERVE_MIN_MS) {
      await this.publish(encodeDpetEnvelopes(encodeDpetFetchError(h, 'busy')), 'fetch-error')
      return
    }

    this.servingKeys.add(serveKey)
    this.lastServeAt.set(req, now)
    const gen = this.serveGeneration
    try {
      const bytes = await loadPetLibraryBytes(h)
      if (gen !== this.serveGeneration || this.equippedHash !== h) return
      if (!bytes) {
        console.warn(`[pets] DPET fetch miss · ${h.slice(0, 12)}… for ${req.slice(0, 10)}…`)
        await this.publish(
          encodeDpetEnvelopes(encodeDpetFetchError(h, 'not_found')),
          'fetch-error'
        )
        return
      }
      if (bytes.byteLength > PET_MAX_BYTES) {
        await this.publish(
          encodeDpetEnvelopes(encodeDpetFetchError(h, 'oversize')),
          'fetch-error'
        )
        return
      }
      console.info(
        `[pets] DPET serve · ${h.slice(0, 12)}… (${bytes.byteLength} B) → ${req.slice(0, 10)}…`
      )
      const stream = encodeDpetGlbChunkStream(h, bytes)
      // Pace chunks and abort if owner clears/swaps mid-serve (rapid toggle).
      for (let i = 0; i < stream.length; i++) {
        if (gen !== this.serveGeneration || this.equippedHash !== h) {
          console.info(`[pets] DPET serve aborted · ${h.slice(0, 12)}… (equip changed)`)
          return
        }
        const ok = await this.publish([stream[i]!], 'fetch-stream')
        if (!ok) return
        if (i > 0 && i % 8 === 0) {
          await new Promise((r) => setTimeout(r, 6))
        }
      }
    } finally {
      this.servingKeys.delete(serveKey)
    }
  }

  private clearPeerFetchState(peer: string): void {
    const prefix = `${peer.toLowerCase()}:`
    for (const k of [...this.incomingFetches.keys()]) {
      if (k.startsWith(prefix)) this.incomingFetches.delete(k)
    }
    for (const k of [...this.pendingRequests]) {
      if (k.startsWith(prefix)) this.pendingRequests.delete(k)
    }
    for (const k of [...this.fetchAttempts.keys()]) {
      if (k.startsWith(prefix)) this.fetchAttempts.delete(k)
    }
    for (const k of [...this.lastFetchRequestAt.keys()]) {
      if (k.startsWith(prefix)) this.lastFetchRequestAt.delete(k)
    }
  }
}
