import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import type { CommsService } from '../../network/CommsService'
import {
  DavMessageType,
  encodeDavAnnounce,
  encodeDavClear,
  encodeDavEnvelopes,
  encodeDavFetchError,
  encodeDavFetchRequest,
  encodeDavVrmChunkStream,
  tryDecodeDavMessage
} from './dclClientAvatar'
import { VRM_MAX_BYTES, type CustomAvatarFormat } from './constants'
import { getEquippedCustomAvatar } from './vrmEquipStorage'
import { getVrmLibraryEntry, loadVrmLibraryBytes } from './VrmLibrary'
import {
  getVrmRamBytes,
  getVrmRamFormat,
  hasVrmRamBytes,
  putVrmRamBytes
} from './vrmRamCache'
import { formatTag, odkNetInfo, odkNetWarn, shortAddr, shortHash } from '../odk/odkNetLog'

export type VrmPeerSyncCallbacks = {
  onPeerVrmChanged: (
    address: string,
    contentHash: string | null,
    format?: CustomAvatarFormat | null
  ) => void
  onPeerVrmBytesReady: (address: string, contentHash: string, format: CustomAvatarFormat) => void
}

type IncomingFetch = {
  provider: string
  hash: string
  totalSize: number
  chunks: Map<number, Uint8Array>
  receivedBytes: number
  startedAt: number
}

const FETCH_TIMEOUT_MS = 120_000

/** P2P custom VRM sync over DAV scene packets (RAM cache only for remote bytes). */
export class VrmPeerSync {
  private comms: CommsService | null = null
  private callbacks: VrmPeerSyncCallbacks | null = null
  private localAddress: string | null = null
  private equippedHash: string | null = null
  private equippedFormat: CustomAvatarFormat = 'vrm'
  /** Last hash successfully published over DAV (undefined = never synced). */
  private publishedHash: string | null | undefined = undefined
  private readonly peerEquippedHash = new Map<string, string | null>()
  private readonly peerEquippedFormat = new Map<string, CustomAvatarFormat>()
  private readonly incomingFetches = new Map<string, IncomingFetch>()
  private readonly pendingRequests = new Set<string>()
  private readonly servingKeys = new Set<string>()
  private readonly fetchAttempts = new Map<string, number>()

  private static readonly MAX_FETCH_ATTEMPTS = 6
  private static readonly FETCH_RETRY_MS = 400

  attach(comms: CommsService, callbacks: VrmPeerSyncCallbacks): void {
    this.comms = comms
    this.callbacks = callbacks
    comms.setAvatarVrmHandler((sender, data) => this.handlePacket(sender, data))
  }

  detach(): void {
    this.comms?.setAvatarVrmHandler(null)
    this.comms = null
    this.callbacks = null
    this.incomingFetches.clear()
    this.pendingRequests.clear()
    this.servingKeys.clear()
    this.fetchAttempts.clear()
  }

  setLocalAddress(address: string | null): void {
    this.localAddress = address?.toLowerCase() ?? null
  }

  getPeerEquippedHash(address: string): string | null {
    return this.peerEquippedHash.get(address.toLowerCase()) ?? null
  }

  getPeerEquippedFormat(address: string): CustomAvatarFormat | null {
    const key = address.toLowerCase()
    if (!this.peerEquippedHash.get(key)) return null
    return this.peerEquippedFormat.get(key) ?? 'vrm'
  }

  /**
   * Re-apply cached DAV equip state after a remote peer record is created.
   * Announce / fetch can finish before onPeerJoin — without this, ODK mesh + locomotion never mount.
   */
  syncPeerToRemoteAvatars(
    address: string,
    remote: {
      setPeerVrmHash: (
        addr: string,
        hash: string | null,
        format?: CustomAvatarFormat | null
      ) => void
      onPeerVrmBytesReady: (addr: string, hash: string, format?: CustomAvatarFormat) => void
    }
  ): void {
    const key = address.toLowerCase()
    const hash = this.peerEquippedHash.get(key)
    if (!hash) return
    const format = this.peerEquippedFormat.get(key) ?? 'vrm'
    const ramReady = hasVrmRamBytes(hash)
    odkNetInfo('peer join — replay cached DAV equip', {
      peer: shortAddr(key),
      format: formatTag(format),
      hash: shortHash(hash),
      ramReady
    })
    remote.setPeerVrmHash(key, hash, format)
    if (ramReady) {
      remote.onPeerVrmBytesReady(key, hash, getVrmRamFormat(hash) ?? format)
    }
  }

  async refreshLocalEquipped(address?: string | null): Promise<void> {
    const equip = getEquippedCustomAvatar(address ?? this.localAddress)
    await this.applyLocalEquip(equip?.contentHash ?? null, equip?.format ?? 'vrm')
  }

  async onLocalEquipChanged(address?: string | null): Promise<void> {
    await this.refreshLocalEquipped(address)
  }

  /** Re-broadcast equipped VRM after scene comms connect (always re-reads equip prefs). */
  async onSceneConnected(): Promise<void> {
    this.publishedHash = undefined
    await this.refreshLocalEquipped(this.localAddress)
  }

  /**
   * Re-announce local equip when a peer joins so late joiners receive DAV state
   * (scene packets are not replayed to participants who were not in the room yet).
   */
  async onPeerJoined(_address: string): Promise<void> {
    if (!this.equippedHash) return
    const bytes = await loadVrmLibraryBytes(this.equippedHash)
    if (!bytes) return
    const entry = await getVrmLibraryEntry(this.equippedHash)
    const format = entry?.format ?? this.equippedFormat
    await this.publishAnnounce(this.equippedHash, bytes.byteLength, format, true)
  }

  onPeerLeave(address: string): void {
    const key = address.toLowerCase()
    this.peerEquippedHash.delete(key)
    this.peerEquippedFormat.delete(key)
    this.clearPeerFetchState(key)
  }

  private clearPeerFetchState(peer: string): void {
    const prefix = `${peer}:`
    for (const fetchKey of [...this.incomingFetches.keys()]) {
      if (fetchKey.startsWith(prefix)) this.incomingFetches.delete(fetchKey)
    }
    for (const reqKey of [...this.pendingRequests]) {
      if (reqKey.startsWith(prefix)) this.pendingRequests.delete(reqKey)
    }
    for (const attemptKey of [...this.fetchAttempts.keys()]) {
      if (attemptKey.startsWith(prefix)) this.fetchAttempts.delete(attemptKey)
    }
  }

  private async applyLocalEquip(
    hash: string | null,
    format: CustomAvatarFormat = 'vrm',
    options?: { force?: boolean }
  ): Promise<void> {
    const normalized = hash?.toLowerCase() ?? null
    this.equippedHash = normalized
    this.equippedFormat = format

    if (!normalized) {
      if (!options?.force && this.publishedHash === null) return
      const sent = await this.publish(encodeDavEnvelopes(encodeDavClear()), 'clear')
      if (sent) {
        this.publishedHash = null
        odkNetInfo('local equip cleared — DAV Clear')
      }
      return
    }

    if (!options?.force && this.publishedHash === normalized) return

    const bytes = await loadVrmLibraryBytes(normalized)
    if (!bytes) {
      odkNetWarn('local equip announce skipped — hash not in library', {
        format: formatTag(format),
        hash: shortHash(normalized)
      })
      return
    }
    const entry = await getVrmLibraryEntry(normalized)
    const resolvedFormat = entry?.format ?? format
    this.equippedFormat = resolvedFormat
    await this.publishAnnounce(normalized, bytes.byteLength, resolvedFormat, options?.force)
  }

  private async publishAnnounce(
    hash: string,
    byteSize: number,
    format: CustomAvatarFormat,
    force = false
  ): Promise<void> {
    if (!force && this.publishedHash === hash) return
    const sent = await this.publish(encodeDavEnvelopes(encodeDavAnnounce(hash, byteSize, format)), 'announce')
    if (sent) this.publishedHash = hash
    odkNetInfo(force ? 'local DAV re-announce (peer joined)' : 'local DAV announce', {
      format: formatTag(format),
      hash: shortHash(hash),
      bytes: byteSize,
      sent
    })
    if (sent) {
      clientDebugLog.log(
        'vrm',
        `DAV announce · ${format} ${hash.slice(0, 12)}… (${byteSize} B)`,
        { level: 'success', throttleMs: 0 }
      )
    }
  }

  private async publish(envelopes: Uint8Array[], kind = 'packet'): Promise<boolean> {
    if (!this.comms || !envelopes.length) {
      odkNetWarn('DAV publish skipped — no comms or empty envelope', { kind })
      return false
    }
    const sent = await this.comms.sendSceneAvatarVrm(envelopes)
    if (!sent) {
      odkNetWarn('DAV publish failed — scene comms not connected', {
        kind,
        packets: envelopes.length
      })
    }
    return sent
  }

  private handlePacket(sender: string, data: Uint8Array): void {
    const from = sender.toLowerCase()
    if (!from || from === this.localAddress) return

    const msg = tryDecodeDavMessage(data)
    if (!msg) return

    switch (msg.type) {
      case DavMessageType.Announce:
        this.onPeerAnnounce(from, msg.hash, msg.byteSize, msg.format)
        break
      case DavMessageType.Clear:
        this.onPeerClear(from)
        break
      case DavMessageType.FetchRequest:
        void this.onFetchRequest(from, msg.hash)
        break
      case DavMessageType.FetchBegin:
        this.onFetchBegin(from, msg.hash, msg.totalSize)
        break
      case DavMessageType.FetchChunk:
        this.onFetchChunk(from, msg.hash, msg.offset, msg.data)
        break
      case DavMessageType.FetchEnd:
        this.onFetchEnd(from, msg.hash)
        break
      case DavMessageType.FetchError:
        this.onFetchError(from, msg.hash, msg.reason)
        break
    }
  }

  private onPeerAnnounce(
    address: string,
    hash: string,
    byteSize: number,
    format: CustomAvatarFormat
  ): void {
    const prev = this.peerEquippedHash.get(address)
    if (prev === hash && this.peerEquippedFormat.get(address) === format) {
      odkNetInfo('peer DAV announce unchanged — skip', {
        peer: shortAddr(address),
        format: formatTag(format),
        hash: shortHash(hash)
      })
      return
    }
    if (prev) this.clearPeerFetchState(address)
    this.peerEquippedHash.set(address, hash)
    this.peerEquippedFormat.set(address, format)
    odkNetInfo('peer DAV announce', {
      peer: shortAddr(address),
      format: formatTag(format),
      hash: shortHash(hash),
      bytes: byteSize,
      hadPrevious: !!prev
    })
    this.callbacks?.onPeerVrmChanged(address, hash, format)

    if (hasVrmRamBytes(hash)) {
      const cachedFormat = getVrmRamFormat(hash) ?? format
      odkNetInfo('peer bytes already in RAM — notify remote avatar', {
        peer: shortAddr(address),
        format: formatTag(cachedFormat),
        hash: shortHash(hash)
      })
      queueMicrotask(() => {
        if (this.peerEquippedHash.get(address) !== hash) return
        this.callbacks?.onPeerVrmBytesReady(address, hash, cachedFormat)
      })
      return
    }

    odkNetInfo('peer bytes missing — DAV fetch request', {
      peer: shortAddr(address),
      format: formatTag(format),
      hash: shortHash(hash)
    })
    void this.requestPeerVrm(address, hash, true)
  }

  private onPeerClear(address: string): void {
    if (!this.peerEquippedHash.has(address)) return
    this.peerEquippedHash.set(address, null)
    this.peerEquippedFormat.delete(address)
    odkNetInfo('peer DAV clear', { peer: shortAddr(address) })
    this.callbacks?.onPeerVrmChanged(address, null, null)
  }

  private async requestPeerVrm(provider: string, hash: string, force = false): Promise<void> {
    const reqKey = `${provider}:${hash}`
    if (hasVrmRamBytes(hash)) return
    if (!force && this.pendingRequests.has(reqKey)) return

    const attempts = (this.fetchAttempts.get(reqKey) ?? 0) + 1
    if (attempts > VrmPeerSync.MAX_FETCH_ATTEMPTS) {
      odkNetWarn('DAV fetch gave up', {
        peer: shortAddr(provider),
        hash: shortHash(hash),
        attempts
      })
      return
    }
    this.fetchAttempts.set(reqKey, attempts)

    this.pendingRequests.add(reqKey)
    await this.publish(encodeDavEnvelopes(encodeDavFetchRequest(hash)), 'fetch-request')
    odkNetInfo('DAV fetch request sent', {
      peer: shortAddr(provider),
      hash: shortHash(hash),
      attempt: attempts
    })
    clientDebugLog.log('vrm', `DAV fetch request → ${provider.slice(0, 8)}… ${hash.slice(0, 12)}… (#${attempts})`)
  }

  private async onFetchRequest(requester: string, hash: string): Promise<void> {
    const serveKey = `${hash}:${requester}`
    if (this.servingKeys.has(serveKey)) {
      await this.publish(encodeDavEnvelopes(encodeDavFetchError(hash, 'busy')))
      return
    }

    const canServe =
      (this.equippedHash === hash && (await loadVrmLibraryBytes(hash))) ||
      getVrmRamBytes(hash)
    if (!canServe) {
      odkNetWarn('DAV fetch serve refused — not_found', {
        requester: shortAddr(requester),
        hash: shortHash(hash),
        localEquipped: shortHash(this.equippedHash)
      })
      await this.publish(encodeDavEnvelopes(encodeDavFetchError(hash, 'not_found')), 'fetch-error')
      return
    }

    const bytes =
      (this.equippedHash === hash ? await loadVrmLibraryBytes(hash) : null) ??
      getVrmRamBytes(hash)
    if (!bytes) {
      await this.publish(encodeDavEnvelopes(encodeDavFetchError(hash, 'not_found')))
      return
    }
    if (bytes.byteLength > VRM_MAX_BYTES) {
      await this.publish(encodeDavEnvelopes(encodeDavFetchError(hash, 'oversize')))
      return
    }

    this.servingKeys.add(serveKey)
    try {
      const envelopes = encodeDavVrmChunkStream(hash, bytes)
      const format = this.equippedHash === hash ? (await getVrmLibraryEntry(hash))?.format : getVrmRamFormat(hash)
      await this.publish(envelopes, 'fetch-serve')
      odkNetInfo('DAV serve complete', {
        requester: shortAddr(requester),
        format: formatTag(format ?? 'vrm'),
        hash: shortHash(hash),
        bytes: bytes.byteLength,
        packets: envelopes.length
      })
      clientDebugLog.log(
        'vrm',
        `DAV serve → ${requester.slice(0, 8)}… ${hash.slice(0, 12)}… (${bytes.byteLength} B, ${envelopes.length} pkt)`,
        { level: 'success' }
      )
    } finally {
      this.servingKeys.delete(serveKey)
    }
  }

  private fetchKey(provider: string, hash: string): string {
    return `${provider}:${hash}`
  }

  private onFetchBegin(provider: string, hash: string, totalSize: number): void {
    if (this.peerEquippedHash.get(provider) !== hash) return
    if (totalSize <= 0) return
    const key = this.fetchKey(provider, hash)
    const existing = this.incomingFetches.get(key)
    // Ignore duplicate FetchBegin while a stream is still assembling (retry overlap).
    if (existing?.hash === hash && existing.totalSize === totalSize && existing.chunks.size > 0) {
      return
    }
    this.incomingFetches.set(key, {
      provider,
      hash,
      totalSize,
      chunks: new Map(),
      receivedBytes: 0,
      startedAt: performance.now()
    })
    odkNetInfo('DAV fetch begin', {
      peer: shortAddr(provider),
      hash: shortHash(hash),
      totalBytes: totalSize
    })
  }

  private onFetchChunk(provider: string, hash: string, offset: number, data: Uint8Array): void {
    if (this.peerEquippedHash.get(provider) !== hash) return
    const key = this.fetchKey(provider, hash)
    const fetch = this.incomingFetches.get(key)
    if (!fetch || fetch.hash !== hash) return
    if (offset < 0 || offset >= fetch.totalSize) return
    if (fetch.chunks.has(offset)) return
    let chunk = data
    if (offset + chunk.byteLength > fetch.totalSize) {
      chunk = chunk.subarray(0, fetch.totalSize - offset)
    }
    if (chunk.byteLength === 0) return
    fetch.chunks.set(offset, chunk)
    fetch.receivedBytes += chunk.byteLength
  }

  private assembleFetch(fetch: IncomingFetch): Uint8Array | null {
    const out = new Uint8Array(fetch.totalSize)
    let written = 0
    const offsets = [...fetch.chunks.keys()].sort((a, b) => a - b)
    for (const off of offsets) {
      const chunk = fetch.chunks.get(off)
      if (!chunk || off < 0 || off >= fetch.totalSize) continue
      const len = Math.min(chunk.byteLength, fetch.totalSize - off)
      if (len <= 0) continue
      out.set(chunk.subarray(0, len), off)
      written += len
    }
    return written >= fetch.totalSize ? out : null
  }

  private failFetchAssembly(provider: string, hash: string, reason: string, detail?: object): void {
    const key = this.fetchKey(provider, hash)
    this.incomingFetches.delete(key)
    odkNetWarn('DAV fetch assembly failed', {
      peer: shortAddr(provider),
      hash: shortHash(hash),
      reason,
      ...detail
    })
    window.setTimeout(() => void this.requestPeerVrm(provider, hash, true), VrmPeerSync.FETCH_RETRY_MS)
  }

  private onFetchEnd(provider: string, hash: string): void {
    const key = this.fetchKey(provider, hash)
    const fetch = this.incomingFetches.get(key)
    this.pendingRequests.delete(key)
    this.fetchAttempts.delete(key)
    if (!fetch || fetch.hash !== hash) return
    if (this.peerEquippedHash.get(provider) !== hash) {
      this.incomingFetches.delete(key)
      return
    }

    try {
      const out = this.assembleFetch(fetch)
      if (!out) {
        this.failFetchAssembly(provider, hash, 'incomplete', {
          chunks: fetch.chunks.size,
          receivedBytes: fetch.receivedBytes,
          total: fetch.totalSize
        })
        return
      }

      this.incomingFetches.delete(key)
      const buffer = out.buffer.slice(out.byteOffset, out.byteOffset + out.byteLength) as ArrayBuffer
      const format = this.peerEquippedFormat.get(provider) ?? 'vrm'
      putVrmRamBytes(hash, buffer, format)
      odkNetInfo('DAV fetch complete — mounting remote avatar', {
        peer: shortAddr(provider),
        format: formatTag(format),
        hash: shortHash(hash),
        bytes: buffer.byteLength
      })
      clientDebugLog.log(
        'vrm',
        `DAV received · ${format} ${provider.slice(0, 8)}… ${hash.slice(0, 12)}… (${buffer.byteLength} B)`,
        { level: 'success' }
      )
      this.callbacks?.onPeerVrmBytesReady(provider, hash, format)
    } catch (err) {
      this.failFetchAssembly(provider, hash, 'error', {
        message: err instanceof Error ? err.message : String(err)
      })
    }
  }

  private onFetchError(provider: string, hash: string, reason: string): void {
    if (this.peerEquippedHash.get(provider) !== hash) return
    const key = this.fetchKey(provider, hash)
    this.pendingRequests.delete(key)
    this.incomingFetches.delete(key)
    odkNetWarn('DAV fetch error', {
      peer: shortAddr(provider),
      hash: shortHash(hash),
      reason
    })
    if (reason === 'busy' || reason === 'not_found') {
      window.setTimeout(
        () => void this.requestPeerVrm(provider, hash, true),
        VrmPeerSync.FETCH_RETRY_MS
      )
    }
  }

  /** Drop stale in-flight fetches. */
  gcStaleFetches(): void {
    const now = performance.now()
    for (const [key, fetch] of this.incomingFetches) {
      if (now - fetch.startedAt > FETCH_TIMEOUT_MS) {
        this.incomingFetches.delete(key)
        this.pendingRequests.delete(key)
        void this.requestPeerVrm(fetch.provider, fetch.hash, true)
      }
    }
  }
}