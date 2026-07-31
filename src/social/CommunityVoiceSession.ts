import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  ConnectionState,
  Room,
  RoomEvent,
  Track,
  type LocalParticipant,
  type Participant,
  type RemoteParticipant,
  type RemoteTrack,
  type RemoteTrackPublication
} from 'livekit-client'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import { parseLiveKitConnectionString } from '../network/comms/livekitAdapter'
import {
  demoteSpeakerGatekeeper,
  joinCommunityVoiceChat,
  promoteSpeakerGatekeeper,
  rejectSpeakRequestGatekeeper,
  requestToSpeakGatekeeper
} from '../network/gatekeeper/communityVoice'
import { voiceChatVolumeMultiplier, volumeToGain, soundSettings } from '../rendering/SoundSettings'
import {
  demoteSpeakerInCommunityVoiceChatViaSocialRpc,
  joinCommunityVoiceChatViaSocialRpc,
  promoteSpeakerInCommunityVoiceChatViaSocialRpc,
  rejectSpeakRequestInCommunityVoiceChatViaSocialRpc,
  requestToSpeakInCommunityVoiceChatViaSocialRpc,
  startCommunityVoiceChatViaSocialRpc
} from './socialServiceV2'

export type CommunityVoiceRole = 'speaker' | 'listener'

export type CommunityVoiceParticipant = {
  /** LiveKit participant identity (usually wallet address). */
  identity: string
  /** Normalized 0x wallet when parseable. */
  wallet: string | null
  name: string
  isLocal: boolean
  /** LiveKit canPublish or metadata role=speaker */
  isSpeaker: boolean
  handRaised: boolean
  isSpeaking: boolean
  isMuted: boolean
  /** Community role from metadata (owner / moderator / member). */
  communityRole: string | null
  /** True if this peer can manage voice (owner/mod/admin). */
  isMod: boolean
}

export type CommunityVoiceSessionState = {
  active: boolean
  communityId: string | null
  role: CommunityVoiceRole
  handRaised: boolean
  canPublish: boolean
  micEnabled: boolean
  participants: CommunityVoiceParticipant[]
}

type StateListener = (state: CommunityVoiceSessionState) => void

/**
 * Separate LiveKit room for community voice (not nearby scene voice).
 * Explorer parity:
 * - join as **listener** (mic off)
 * - request to speak (raise hand)
 * - mod promote / reject / demote
 * - start as speaker; end-for-everyone is Social RPC (caller)
 */
export class CommunityVoiceSession {
  private room: Room | null = null
  private communityId: string | null = null
  private role: CommunityVoiceRole = 'listener'
  private handRaised = false
  private identity: AuthIdentity | null = null
  private userAddress: string | null = null
  private communityRole: string | null = null
  private audioHost: HTMLDivElement | null = null
  private readonly remotes = new Map<string, HTMLAudioElement>()
  private unsubSound: (() => void) | null = null
  private readonly listeners = new Set<StateListener>()

  constructor() {
    this.unsubSound = soundSettings.subscribe(() => this.applyVolumes())
  }

  subscribe(fn: StateListener): () => void {
    this.listeners.add(fn)
    fn(this.getState())
    return () => this.listeners.delete(fn)
  }

  getState(): CommunityVoiceSessionState {
    return {
      active: this.isActive(),
      communityId: this.communityId,
      role: this.role,
      handRaised: this.handRaised,
      canPublish: this.localCanPublish(),
      micEnabled: this.room?.localParticipant.isMicrophoneEnabled === true,
      participants: this.collectParticipants()
    }
  }

  isActive(): boolean {
    return this.room?.state === ConnectionState.Connected
  }

  getCommunityId(): string | null {
    return this.communityId
  }

  getRole(): CommunityVoiceRole {
    return this.role
  }

  isHandRaised(): boolean {
    return this.handRaised
  }

  /**
   * True when the local user is a community owner/mod and no *other* mod is
   * still in the LiveKit room (by published communityRole metadata).
   * Used so the last remaining mod ends the voice chat on leave.
   */
  isSoleRemainingMod(): boolean {
    if (!this.isActive()) return false
    if (!isCommunityVoiceModRole(this.communityRole)) return false
    const others = this.collectParticipants().filter(
      (p) => !p.isLocal && p.isMod
    )
    return others.length === 0
  }

  /**
   * Start (mod) or join (listener) a community voice stream.
   * Prefers Social Service v2 credentials; falls back to gatekeeper signed-fetch.
   */
  async join(options: {
    identity: AuthIdentity
    communityId: string
    userAddress: string
    /** create/start as mod, or join existing stream */
    action?: 'create' | 'join'
    displayName?: string
    /** Community role for gatekeeper fallback */
    userRole?: string | null
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    await this.leave()

    const action = options.action ?? 'join'
    const asSpeaker = action === 'create'
    let connectionUrl = ''

    if (action === 'create') {
      const rpc = await startCommunityVoiceChatViaSocialRpc(options.identity, options.communityId)
      if (rpc.ok) {
        connectionUrl = rpc.value.connectionUrl
      } else {
        const gk = await joinCommunityVoiceChat(options.identity, {
          communityId: options.communityId,
          userAddress: options.userAddress,
          action: 'create',
          userRole: options.userRole,
          profileName: options.displayName
        })
        if (!gk.ok) return { ok: false, error: rpc.error || gk.error }
        connectionUrl = gk.connectionUrl
      }
    } else {
      const rpc = await joinCommunityVoiceChatViaSocialRpc(options.identity, options.communityId)
      if (rpc.ok) {
        connectionUrl = rpc.value.connectionUrl
      } else {
        const gk = await joinCommunityVoiceChat(options.identity, {
          communityId: options.communityId,
          userAddress: options.userAddress,
          action: 'join',
          userRole: options.userRole,
          profileName: options.displayName
        })
        if (!gk.ok) return { ok: false, error: rpc.error || gk.error }
        connectionUrl = gk.connectionUrl
      }
    }

    return this.connectRoom({
      connectionUrl,
      communityId: options.communityId,
      identity: options.identity,
      userAddress: options.userAddress,
      userRole: options.userRole ?? null,
      asSpeaker
    })
  }

  /** Raise or lower hand (request to speak). */
  async setHandRaised(raise: boolean): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isActive() || !this.identity || !this.communityId || !this.userAddress) {
      return { ok: false, error: 'not_in_voice' }
    }
    if (this.role === 'speaker' && raise) {
      return { ok: false, error: 'already_speaker' }
    }

    const rpc = await requestToSpeakInCommunityVoiceChatViaSocialRpc(
      this.identity,
      this.communityId,
      raise
    )
    if (!rpc.ok) {
      const gk = raise
        ? await requestToSpeakGatekeeper(this.identity, this.communityId, this.userAddress)
        : await rejectSpeakRequestGatekeeper(this.identity, this.communityId, this.userAddress)
      if (!gk.ok) return { ok: false, error: rpc.error || gk.error }
    }

    this.handRaised = raise
    await this.publishLocalMetadata()
    this.emit()
    return { ok: true }
  }

  /** Moderator: accept speak request / promote to speaker. */
  async promoteSpeaker(userAddress: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.identity || !this.communityId) return { ok: false, error: 'not_in_voice' }
    const addr = userAddress.trim().toLowerCase()
    const rpc = await promoteSpeakerInCommunityVoiceChatViaSocialRpc(
      this.identity,
      this.communityId,
      addr
    )
    if (!rpc.ok) {
      const gk = await promoteSpeakerGatekeeper(this.identity, this.communityId, addr)
      if (!gk.ok) return { ok: false, error: rpc.error || gk.error }
    }
    // If we promoted ourselves (mod self), enable mic when allowed.
    if (addr === this.userAddress?.toLowerCase()) {
      this.role = 'speaker'
      this.handRaised = false
      await this.tryEnableMic()
    }
    this.emit()
    return { ok: true }
  }

  /** Moderator: demote speaker → listener. */
  async demoteSpeaker(userAddress: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.identity || !this.communityId) return { ok: false, error: 'not_in_voice' }
    const addr = userAddress.trim().toLowerCase()
    const rpc = await demoteSpeakerInCommunityVoiceChatViaSocialRpc(
      this.identity,
      this.communityId,
      addr
    )
    if (!rpc.ok) {
      const gk = await demoteSpeakerGatekeeper(this.identity, this.communityId, addr)
      if (!gk.ok) return { ok: false, error: rpc.error || gk.error }
    }
    if (addr === this.userAddress?.toLowerCase()) {
      this.role = 'listener'
      await this.setMicEnabled(false)
    }
    this.emit()
    return { ok: true }
  }

  /** Moderator: reject speak request (lower hand for user). */
  async rejectSpeakRequest(userAddress: string): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.identity || !this.communityId) return { ok: false, error: 'not_in_voice' }
    const addr = userAddress.trim().toLowerCase()
    const rpc = await rejectSpeakRequestInCommunityVoiceChatViaSocialRpc(
      this.identity,
      this.communityId,
      addr
    )
    if (!rpc.ok) {
      const gk = await rejectSpeakRequestGatekeeper(this.identity, this.communityId, addr)
      if (!gk.ok) return { ok: false, error: rpc.error || gk.error }
    }
    if (addr === this.userAddress?.toLowerCase()) {
      this.handRaised = false
      await this.publishLocalMetadata()
    }
    this.emit()
    return { ok: true }
  }

  async setMicEnabled(enabled: boolean): Promise<void> {
    if (!this.room) return
    if (enabled && !this.localCanPublish() && this.role !== 'speaker') {
      clientDebugLog.log('social', 'Community voice mic blocked — not a speaker', {
        level: 'warn',
        alsoConsole: true
      })
      return
    }
    try {
      await this.room.localParticipant.setMicrophoneEnabled(enabled)
    } catch (err) {
      clientDebugLog.log(
        'social',
        `Community voice mic ${enabled ? 'on' : 'off'} failed: ${err instanceof Error ? err.message : err}`,
        { level: 'warn', alsoConsole: true }
      )
    }
    this.emit()
  }

  async leave(): Promise<void> {
    this.clearRemotes()
    if (this.room) {
      try {
        await this.room.localParticipant.setMicrophoneEnabled(false)
      } catch {
        /* ignore */
      }
      this.room.removeAllListeners()
      this.room.disconnect()
      this.room = null
    }
    this.communityId = null
    this.role = 'listener'
    this.handRaised = false
    this.identity = null
    this.userAddress = null
    this.communityRole = null
    this.emit()
  }

  dispose(): void {
    void this.leave()
    this.unsubSound?.()
    this.unsubSound = null
    this.listeners.clear()
    this.audioHost?.remove()
    this.audioHost = null
  }

  private async connectRoom(opts: {
    connectionUrl: string
    communityId: string
    identity: AuthIdentity
    userAddress: string
    userRole: string | null
    asSpeaker: boolean
  }): Promise<{ ok: true } | { ok: false; error: string }> {
    let url: string
    let token: string
    try {
      ;({ url, token } = parseLiveKitConnectionString(opts.connectionUrl))
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }

    const room = new Room({ adaptiveStream: false, dynacast: false })
    room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      if (track.kind !== Track.Kind.Audio) return
      this.attachRemote(track as RemoteTrack, pub as RemoteTrackPublication, participant as RemoteParticipant)
      this.emit()
    })
    room.on(RoomEvent.TrackUnsubscribed, (_track, pub, participant) => {
      const key = `${participant.identity}:${pub.trackSid}`
      this.detachRemote(key)
      this.emit()
    })
    room.on(RoomEvent.ParticipantConnected, () => this.emit())
    room.on(RoomEvent.ParticipantDisconnected, () => this.emit())
    room.on(RoomEvent.ActiveSpeakersChanged, () => this.emit())
    room.on(RoomEvent.ParticipantMetadataChanged, () => this.emit())
    room.on(RoomEvent.ParticipantAttributesChanged, () => this.emit())
    room.on(RoomEvent.ParticipantPermissionsChanged, (_prev, participant) => {
      if (participant?.isLocal) void this.onLocalPermissionsChanged(participant as LocalParticipant)
    })
    room.on(RoomEvent.Disconnected, () => {
      this.clearRemotes()
      this.communityId = null
      this.room = null
      this.role = 'listener'
      this.handRaised = false
      this.emit()
    })

    try {
      await room.connect(url, token)
    } catch (err) {
      room.disconnect()
      const msg = err instanceof Error ? err.message : String(err)
      return { ok: false, error: msg }
    }

    this.room = room
    this.communityId = opts.communityId
    this.identity = opts.identity
    this.userAddress = opts.userAddress.toLowerCase()
    this.communityRole = opts.userRole
    this.role = opts.asSpeaker || this.localCanPublish() ? 'speaker' : 'listener'
    this.handRaised = false

    await this.publishLocalMetadata()

    // Listeners stay muted; starters / token speakers get mic.
    if (this.role === 'speaker') {
      await this.tryEnableMic()
    } else {
      try {
        await room.localParticipant.setMicrophoneEnabled(false)
      } catch {
        /* ignore */
      }
    }

    for (const p of room.remoteParticipants.values()) {
      for (const pub of p.trackPublications.values()) {
        if (pub.kind === Track.Kind.Audio && pub.track) {
          this.attachRemote(pub.track as RemoteTrack, pub as RemoteTrackPublication, p)
        }
      }
    }

    clientDebugLog.log(
      'social',
      `Community voice joined · ${opts.communityId} · role=${this.role}`,
      { level: 'success', alsoConsole: true }
    )
    this.emit()
    return { ok: true }
  }

  private async onLocalPermissionsChanged(local: LocalParticipant): Promise<void> {
    const can = local.permissions?.canPublish === true
    if (can && this.role !== 'speaker') {
      this.role = 'speaker'
      this.handRaised = false
      await this.publishLocalMetadata()
      await this.tryEnableMic()
      clientDebugLog.log('social', 'Community voice — promoted to speaker (LiveKit permissions)', {
        level: 'success',
        alsoConsole: true
      })
    } else if (!can && this.role === 'speaker') {
      this.role = 'listener'
      await this.setMicEnabled(false)
      await this.publishLocalMetadata()
      clientDebugLog.log('social', 'Community voice — demoted to listener', {
        level: 'info',
        alsoConsole: true
      })
    }
    this.emit()
  }

  private localCanPublish(): boolean {
    return this.room?.localParticipant.permissions?.canPublish === true
  }

  private async tryEnableMic(): Promise<void> {
    if (!this.room) return
    // Wait briefly for permission propagation after promote.
    for (let i = 0; i < 8; i++) {
      if (this.localCanPublish() || this.role === 'speaker') break
      await new Promise((r) => setTimeout(r, 100))
    }
    try {
      await this.room.localParticipant.setMicrophoneEnabled(true)
      this.role = 'speaker'
    } catch (err) {
      clientDebugLog.log(
        'social',
        `Community voice enable mic failed: ${err instanceof Error ? err.message : err}`,
        { level: 'warn', alsoConsole: true }
      )
    }
    this.emit()
  }

  private async publishLocalMetadata(): Promise<void> {
    if (!this.room) return
    const roleNorm = (this.communityRole ?? '').trim().toLowerCase()
    const meta = JSON.stringify({
      role: this.role,
      isRequestingToSpeak: this.handRaised,
      handRaised: this.handRaised,
      communityRole: roleNorm
    })
    try {
      await this.room.localParticipant.setMetadata(meta)
    } catch {
      /* older LiveKit tokens may disallow */
    }
    try {
      await this.room.localParticipant.setAttributes({
        role: this.role,
        isRequestingToSpeak: this.handRaised ? 'true' : 'false',
        handRaised: this.handRaised ? 'true' : 'false',
        communityRole: roleNorm
      })
    } catch {
      /* ignore */
    }
  }

  private collectParticipants(): CommunityVoiceParticipant[] {
    const out: CommunityVoiceParticipant[] = []
    if (!this.room) return out

    const push = (p: Participant, isLocal: boolean) => {
      const parsed = parseParticipantMeta(p)
      const wallet = walletFromIdentity(isLocal ? this.userAddress ?? p.identity : p.identity)
      const communityRole = isLocal
        ? (this.communityRole ?? '').trim().toLowerCase() || null
        : parsed.communityRole
      const isSpeaker =
        isLocal
          ? this.role === 'speaker' || this.localCanPublish()
          : parsed.isSpeaker || p.permissions?.canPublish === true
      out.push({
        identity: p.identity,
        wallet,
        name: p.name?.trim() || (wallet ? shortAddr(wallet) : shortAddr(p.identity)),
        isLocal,
        isSpeaker,
        handRaised: isLocal ? this.handRaised : parsed.handRaised,
        isSpeaking: p.isSpeaking,
        isMuted: isLocal
          ? !this.room!.localParticipant.isMicrophoneEnabled
          : ![...p.audioTrackPublications.values()].some((pub) => !pub.isMuted && pub.track),
        communityRole,
        isMod: isCommunityVoiceModRole(communityRole)
      })
    }

    push(this.room.localParticipant, true)
    for (const p of this.room.remoteParticipants.values()) push(p, false)
    // Speakers first, then raised hands, then alpha
    out.sort((a, b) => {
      if (a.isLocal !== b.isLocal) return a.isLocal ? -1 : 1
      if (a.isSpeaker !== b.isSpeaker) return a.isSpeaker ? -1 : 1
      if (a.handRaised !== b.handRaised) return a.handRaised ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    return out
  }

  private emit(): void {
    const state = this.getState()
    for (const fn of this.listeners) {
      try {
        fn(state)
      } catch {
        /* ignore */
      }
    }
  }

  private ensureHost(): HTMLDivElement {
    if (this.audioHost?.isConnected) return this.audioHost
    const host = document.createElement('div')
    host.id = 'community-voice-audio-host'
    host.setAttribute('aria-hidden', 'true')
    host.style.cssText =
      'position:fixed;width:1px;height:1px;overflow:hidden;opacity:0.01;pointer-events:none;left:0;top:0'
    document.body.appendChild(host)
    this.audioHost = host
    return host
  }

  private attachRemote(
    track: RemoteTrack,
    publication: RemoteTrackPublication,
    participant: RemoteParticipant
  ): void {
    const key = `${participant.identity}:${publication.trackSid}`
    if (this.remotes.has(key)) return
    const el = track.attach() as HTMLAudioElement
    el.autoplay = true
    el.setAttribute('playsinline', 'true')
    el.volume = remoteGain()
    this.ensureHost().appendChild(el)
    void el.play().catch(() => {
      /* autoplay policy */
    })
    this.remotes.set(key, el)
  }

  private detachRemote(key: string): void {
    const el = this.remotes.get(key)
    if (!el) return
    try {
      el.pause()
      el.srcObject = null
      el.remove()
    } catch {
      /* ignore */
    }
    this.remotes.delete(key)
  }

  private clearRemotes(): void {
    for (const key of [...this.remotes.keys()]) this.detachRemote(key)
  }

  private applyVolumes(): void {
    const g = remoteGain()
    for (const el of this.remotes.values()) el.volume = g
  }
}

function parseParticipantMeta(p: Participant): {
  isSpeaker: boolean
  handRaised: boolean
  communityRole: string | null
} {
  let isSpeaker = false
  let handRaised = false
  let communityRole: string | null = null
  const attrs = p.attributes ?? {}
  if (attrs.role === 'speaker' || attrs.isSpeaker === 'true') isSpeaker = true
  if (attrs.handRaised === 'true' || attrs.isRequestingToSpeak === 'true') handRaised = true
  if (typeof attrs.communityRole === 'string' && attrs.communityRole.trim()) {
    communityRole = attrs.communityRole.trim().toLowerCase()
  }
  const raw = p.metadata?.trim()
  if (raw) {
    try {
      const o = JSON.parse(raw) as Record<string, unknown>
      if (o.role === 'speaker' || o.isSpeaker === true) isSpeaker = true
      if (o.handRaised === true || o.isRequestingToSpeak === true) handRaised = true
      if (typeof o.communityRole === 'string' && o.communityRole.trim()) {
        communityRole = o.communityRole.trim().toLowerCase()
      }
    } catch {
      /* ignore */
    }
  }
  return { isSpeaker, handRaised, communityRole }
}

export function isCommunityVoiceModRole(role: string | null | undefined): boolean {
  const r = (role ?? '').trim().toLowerCase()
  return r === 'owner' || r === 'moderator' || r === 'mod' || r === 'admin'
}

/** Extract 0x wallet from LiveKit identity (raw address or prefixed). */
export function walletFromIdentity(identity: string | null | undefined): string | null {
  if (!identity) return null
  const t = identity.trim().toLowerCase()
  if (/^0x[a-f0-9]{40}$/.test(t)) return t
  const m = t.match(/0x[a-f0-9]{40}/)
  return m ? m[0] : null
}

function shortAddr(id: string): string {
  const t = id.trim()
  const w = walletFromIdentity(t)
  if (w) return `${w.slice(0, 6)}…${w.slice(-4)}`
  return t.length > 16 ? `${t.slice(0, 12)}…` : t
}

function remoteGain(): number {
  return Math.min(
    1,
    Math.max(0, voiceChatVolumeMultiplier() * volumeToGain(soundSettings.get().masterVolume))
  )
}

/** App-wide singleton so Settings + /communities share one session. */
let sharedCommunityVoice: CommunityVoiceSession | null = null

export function getCommunityVoiceSession(): CommunityVoiceSession {
  if (!sharedCommunityVoice) sharedCommunityVoice = new CommunityVoiceSession()
  return sharedCommunityVoice
}
