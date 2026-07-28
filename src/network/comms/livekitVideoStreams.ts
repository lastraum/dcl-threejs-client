import {
  ConnectionState,
  Track,
  type Participant,
  type RemoteTrackPublication,
  type Room
} from 'livekit-client'
import { VideoTrackSourceType } from '@dcl/protocol/out-ts/decentraland/kernel/apis/comms_api.gen'

export type ActiveVideoStream = {
  identity: string
  trackSid: string
  sourceType: VideoTrackSourceType
}

function mapTrackSource(source: Track.Source): VideoTrackSourceType {
  if (source === Track.Source.ScreenShare) return VideoTrackSourceType.VTST_SCREEN_SHARE
  if (source === Track.Source.Camera) return VideoTrackSourceType.VTST_CAMERA
  return VideoTrackSourceType.VTST_UNKNOWN
}

function isVideoKind(kind: unknown): boolean {
  if (kind === Track.Kind.Video) return true
  return String(kind).toLowerCase() === 'video'
}

function isAudioKind(kind: unknown): boolean {
  if (kind === Track.Kind.Audio) return true
  return String(kind).toLowerCase() === 'audio'
}

/**
 * Stream A/V audio sources (OBS screen-share audio, unknown/ingress).
 * Microphone is usually peer voice — only attached when it is the *same* video publisher
 * (LiveKit RTMP ingress often labels ingress audio as Microphone).
 */
function isNonMicStreamAudioSource(source: Track.Source): boolean {
  return source !== Track.Source.Microphone
}

function trackSidOf(track: Track, publication?: RemoteTrackPublication): string {
  const fromPub = publication?.trackSid?.trim()
  if (fromPub) return fromPub
  return typeof track.sid === 'string' ? track.sid.trim() : ''
}

function collectFromParticipant(participant: Participant, out: ActiveVideoStream[]): void {
  const identity = participant.identity?.trim()
  if (!identity) return

  for (const publication of participant.trackPublications.values()) {
    if (!isVideoKind(publication.kind)) continue
    const trackSid = publication.trackSid
    if (!trackSid) continue
    out.push({
      identity,
      trackSid,
      sourceType: mapTrackSource(publication.source)
    })
  }
}

/** Enumerate published video tracks in a LiveKit room (local + remote). */
export function collectActiveVideoStreamsFromRoom(room: Room | null): ActiveVideoStream[] {
  if (!room) return []
  const streams: ActiveVideoStream[] = []
  collectFromParticipant(room.localParticipant, streams)
  for (const participant of room.remoteParticipants.values()) {
    collectFromParticipant(participant, streams)
  }
  return streams
}

export type RemoteVideoPresenceSnapshot = {
  live: boolean
  remoteParticipants: number
  remoteVideoPubs: number
  details: string[]
}

/**
 * Cast / RTMP ingress video presence.
 * - Remote video pubs (normal OBS → LiveKit ingress participant)
 * - Local non-camera video (some gateways attach ingress under the session identity)
 * Companion primarily counts remote TrackSubscribed; we are more permissive for landing CTA.
 */
export function snapshotRemoteVideoPresence(room: Room | null): RemoteVideoPresenceSnapshot {
  if (!room) {
    return { live: false, remoteParticipants: 0, remoteVideoPubs: 0, details: [] }
  }
  const details: string[] = []
  let remoteVideoPubs = 0
  let remoteParticipants = 0

  const consider = (participant: Participant, role: 'remote' | 'local'): void => {
    const id = participant.identity?.trim() || role
    const pubs = [...participant.trackPublications.values()]
    if (pubs.length === 0 && role === 'remote') {
      details.push(`${role}:${id.slice(0, 14)} (no pubs)`)
      return
    }
    for (const publication of pubs) {
      const kind = String(publication.kind)
      const src = String(publication.source)
      const sid = (publication.trackSid || 'no-sid').slice(0, 12)
      const sub = publication.isSubscribed ? 'sub' : 'unsub'
      const hasTrack = publication.track ? 'track' : 'no-track'
      if (!isVideoKind(publication.kind)) {
        details.push(`${role}:${id.slice(0, 10)} ${kind}/${src}`)
        continue
      }
      // Skip local webcam — only Cast-like sources on local (screen / unknown / other).
      if (role === 'local' && publication.source === Track.Source.Camera) continue
      remoteVideoPubs += 1
      details.push(`${role}:${id.slice(0, 10)} video/${src} ${sub} ${hasTrack} ${sid}`)
    }
  }

  for (const participant of room.remoteParticipants.values()) {
    if (participant.isLocal) continue
    remoteParticipants += 1
    consider(participant, 'remote')
  }
  consider(room.localParticipant, 'local')

  return {
    live: remoteVideoPubs > 0,
    remoteParticipants,
    remoteVideoPubs,
    details
  }
}

export function countRemoteVideoPublications(room: Room | null): number {
  return snapshotRemoteVideoPresence(room).remoteVideoPubs
}

export function roomHasRemoteVideo(room: Room | null): boolean {
  return snapshotRemoteVideoPresence(room).live
}

/** Force-subscribe every remote video publication (companion scene-watch parity). */
export function forceSubscribeRemoteVideo(room: Room | null): number {
  if (!room || room.state !== ConnectionState.Connected) return 0
  let n = 0
  for (const participant of room.remoteParticipants.values()) {
    if (participant.isLocal) continue
    for (const publication of participant.trackPublications.values()) {
      if (!isVideoKind(publication.kind)) continue
      const rp = publication as RemoteTrackPublication
      if (rp.isSubscribed && rp.track) {
        n += 1
        continue
      }
      n += 1
      try {
        rp.setSubscribed(true)
      } catch {
        /* ignore — room may be tearing down */
      }
    }
  }
  return n
}

/**
 * Force-subscribe remote audio that may belong to a cast/ingress stream.
 * LiveKit RTMP / Cast publish audio as a separate track from video — without this the
 * 2D landing cast stage is silent even when mute UI shows unmuted.
 */
export function forceSubscribeRemoteStreamAudio(
  room: Room | null,
  preferredIdentity?: string
): number {
  if (!room || room.state !== ConnectionState.Connected) return 0
  const preferred = (preferredIdentity ?? '').trim().toLowerCase()
  let n = 0
  for (const participant of room.remoteParticipants.values()) {
    if (participant.isLocal) continue
    const identity = (participant.identity ?? '').trim().toLowerCase()
    const samePublisher = preferred.length > 0 && identity === preferred
    for (const publication of participant.trackPublications.values()) {
      if (!isAudioKind(publication.kind)) continue
      // Same video publisher: subscribe all audio (ingress often = Microphone).
      // Other peers: only non-mic (ScreenShareAudio / unknown) so we do not pull every voice.
      if (!samePublisher && !isNonMicStreamAudioSource(publication.source)) continue
      const rp = publication as RemoteTrackPublication
      n += 1
      if (rp.isSubscribed && rp.track) continue
      try {
        rp.setSubscribed(true)
      } catch {
        /* ignore */
      }
    }
  }
  return n
}

type RemoteStreamAudioPick = {
  track: Track
  publication: RemoteTrackPublication
  identity: string
  sid: string
}

/**
 * Companion audio for a cast/ingress video publisher.
 * Prefer same-participant audio (incl. mic-labelled ingress); else any remote non-mic audio.
 */
function pickCompanionStreamAudioTracks(
  room: Room,
  preferredIdentity: string
): RemoteStreamAudioPick[] {
  forceSubscribeRemoteStreamAudio(room, preferredIdentity)
  const preferred = preferredIdentity.trim().toLowerCase()
  const same: RemoteStreamAudioPick[] = []
  const others: RemoteStreamAudioPick[] = []

  for (const p of room.remoteParticipants.values()) {
    if (p.isLocal) continue
    const identity = p.identity?.trim() || ''
    const isPreferred = preferred.length > 0 && identity.toLowerCase() === preferred
    for (const pub of p.trackPublications.values()) {
      if (!isAudioKind(pub.kind)) continue
      // Same publisher: take mic + stream audio. Others: stream-only (no peer voice).
      if (!isPreferred && !isNonMicStreamAudioSource(pub.source)) continue
      const rp = pub as RemoteTrackPublication
      if (!rp.isSubscribed) {
        try {
          rp.setSubscribed(true)
        } catch {
          /* ignore */
        }
      }
      const t = rp.track
      if (!t || !isAudioKind(t.kind)) continue
      if (rp.isMuted === true) continue
      const sid = trackSidOf(t, rp) || `${identity}-audio`
      const row: RemoteStreamAudioPick = { track: t, publication: rp, identity, sid }
      if (isPreferred) same.push(row)
      else others.push(row)
    }
  }
  // Same publisher first; otherwise any stream audio (single OBS room common case).
  return same.length > 0 ? same : others
}

/**
 * Attach (or keep) hidden `<audio>` elements for stream audio next to the cast `<video>`.
 * When `preserveAudioUi` is true, do not overwrite mute/volume (landing mute toggle owns them).
 */
function ensureCompanionStreamAudioOnHost(
  room: Room,
  host: HTMLElement,
  preferredIdentity: string,
  opts?: { muted?: boolean; volume?: number },
  preserveAudioUi = false
): void {
  const picks = pickCompanionStreamAudioTracks(room, preferredIdentity)
  const wanted = new Set(picks.map((p) => p.sid))

  // Drop stale stream-audio elements (publisher swap / unpublish).
  host.querySelectorAll('audio[data-cast-audio-sid]').forEach((node) => {
    const el = node as HTMLAudioElement
    const sid = el.dataset.castAudioSid ?? ''
    if (wanted.has(sid)) return
    try {
      el.pause()
      el.srcObject = null
      el.remove()
    } catch {
      /* ignore */
    }
  })

  const muted = opts?.muted === true
  const volume = muted ? 0 : Math.min(1, Math.max(0, opts?.volume ?? 1))

  for (const pick of picks) {
    const existing = Array.from(host.querySelectorAll('audio[data-cast-audio-sid]')).find(
      (node) => (node as HTMLAudioElement).dataset.castAudioSid === pick.sid
    ) as HTMLAudioElement | undefined
    if (existing?.isConnected) {
      if (!preserveAudioUi) {
        existing.muted = muted
        existing.volume = volume
      }
      if (existing.paused) void existing.play().catch(() => {})
      continue
    }

    try {
      pick.track.detach().forEach((n) => {
        if (n !== existing) n.remove()
      })
    } catch {
      /* ignore */
    }

    const el = pick.track.attach()
    if (!(el instanceof HTMLMediaElement)) continue
    const audio = el as HTMLAudioElement
    audio.autoplay = true
    audio.dataset.castAudioSid = pick.sid
    audio.className = 'scene-watch-cast-stage__audio'
    // Keep out of layout; volume still applies.
    audio.style.cssText =
      'position:absolute;width:0;height:0;opacity:0;pointer-events:none;overflow:hidden'
    if (preserveAudioUi) {
      // Match current video mute state if present (Join-live gesture already set UI).
      const video = host.querySelector('video') as HTMLVideoElement | null
      if (video) {
        audio.muted = video.muted
        audio.volume = video.volume
      } else {
        audio.muted = muted
        audio.volume = volume
      }
    } else {
      audio.muted = muted
      audio.volume = volume
    }
    host.appendChild(audio)
    void audio.play().catch(() => {})
  }
}

/** Unity `PRESENTATION_BOT_IDENTITY_PREFIX` — DCL Cast slide/presentation publisher. */
export const PRESENTATION_BOT_IDENTITY_PREFIX = 'presentation-bot:'

/**
 * LiveKit RTMP stream-key ingress identity suffix (e.g. `9bc830ea-…-streamer`).
 * These participants publish screen A/V only — never player avatars.
 */
export const STREAMER_IDENTITY_SUFFIX = '-streamer'

export function isPresentationBotIdentity(identity: string | undefined | null): boolean {
  return (identity ?? '').toLowerCase().startsWith(PRESENTATION_BOT_IDENTITY_PREFIX)
}

/** RTMP / stream-key ingress publisher (OBS → LiveKit). */
export function isStreamerIngressIdentity(identity: string | undefined | null): boolean {
  const id = (identity ?? '').trim().toLowerCase()
  return id.endsWith(STREAMER_IDENTITY_SUFFIX)
}

/**
 * LiveKit room members that must not spawn remote avatars or RFC4 peer plumbing.
 * Still valid for video/audio track attach on `livekit-video://current-stream`.
 */
export function isNonPlayerLiveKitIdentity(identity: string | undefined | null): boolean {
  if (!identity?.trim()) return true
  return isPresentationBotIdentity(identity) || isStreamerIngressIdentity(identity)
}

/**
 * Priority for scene `livekit-video://current-stream` (Unity LivekitPlayer.BestInitialVideoKey):
 * stream-key ingress / presentation bot → screen share → camera → other.
 *
 * RTMP ingress is often labelled `camera` — without identity boost it ties with real
 * peer webcams and can attach the wrong (or empty) track.
 */
function videoSourceTier(source: Track.Source, identity: string): number {
  if (isStreamerIngressIdentity(identity) || isPresentationBotIdentity(identity)) return -2
  if (source === Track.Source.ScreenShare) return 0
  if (source === Track.Source.Camera) return 1
  return 2 // unknown / other ingress-style
}

type RemoteVideoPick = {
  track: Track
  publication: RemoteTrackPublication
  identity: string
}

function trackPublicationArea(track: Track): number {
  try {
    const ms = (track as unknown as { mediaStreamTrack?: MediaStreamTrack }).mediaStreamTrack
    const s = ms?.getSettings?.()
    return Math.max(0, s?.width ?? 0) * Math.max(0, s?.height ?? 0)
  } catch {
    return 0
  }
}

/**
 * Unity `BestInitialVideoKey` / companion pick — remote video only (no local webcam fallback).
 * Force-subscribes pubs; accepts any video source (screen, camera, OBS ingress/unknown).
 * Owner leave does **not** clear VideoPlayer — only when no remote video remains does attach go black.
 */
export function pickBestRemoteVideoTrack(room: Room | null): RemoteVideoPick | null {
  if (!room || room.state !== ConnectionState.Connected) return null
  forceSubscribeRemoteVideo(room)
  type Scored = RemoteVideoPick & { tier: number; area: number; muted: boolean }
  const rows: Scored[] = []
  for (const p of room.remoteParticipants.values()) {
    if (p.isLocal) continue
    const identity = p.identity?.trim() || ''
    for (const pub of p.trackPublications.values()) {
      if (!isVideoKind(pub.kind)) continue
      const rp = pub as RemoteTrackPublication
      // Prefer subscribed track; still force-sub so late RTMP ingress can appear on next poll.
      if (!rp.isSubscribed) {
        try {
          rp.setSubscribed(true)
        } catch {
          /* ignore */
        }
      }
      const t = rp.track
      if (!t || !isVideoKind(t.kind)) continue
      // Unity skips muted (paused) screen share so camera/ingress can take over.
      const muted = rp.isMuted === true
      if (pub.source === Track.Source.ScreenShare && muted) continue
      rows.push({
        track: t,
        publication: rp,
        identity,
        tier: videoSourceTier(pub.source, identity),
        area: trackPublicationArea(t),
        muted
      })
    }
  }
  if (rows.length === 0) return null
  rows.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.muted !== b.muted) return a.muted ? 1 : -1
    return b.area - a.area
  })
  return rows[0]!
}

/**
 * Scene VideoPlayer `livekit-video://current-stream` track — same priority as Unity explorer.
 * Returns the LiveKit Track to attach (or null while waiting for OBS/Cast publishers).
 */
export function pickCurrentStreamVideoTrack(room: Room | null): Track | null {
  return pickBestRemoteVideoTrack(room)?.track ?? null
}

/**
 * Companion `reattachFirstRemoteVideoTrack` — force-sub, pick best, attach into host.
 * Also attaches companion stream **audio** (separate LiveKit track from OBS/Cast).
 * Returns true when a `<video>` is showing.
 * **Does not remount** if the same track SID is already attached (avoids flicker).
 */
export function reattachFirstRemoteVideoToHost(
  room: Room | null,
  host: HTMLElement,
  opts?: { muted?: boolean; volume?: number; controls?: boolean }
): boolean {
  if (!room || room.state !== ConnectionState.Connected) {
    // Room dropped while watching — clear stale <video> so UI can exit cast stage.
    if (host.querySelector('video') || host.dataset.castTrackSid) {
      clearCastVideoHost(host)
    }
    return false
  }
  const pick = pickBestRemoteVideoTrack(room)
  if (!pick) {
    // Publisher stopped / unpublished — remove blank player so landing can return to details.
    if (host.querySelector('video') || host.dataset.castTrackSid) {
      clearCastVideoHost(host)
    }
    return false
  }

  const nextSid =
    trackSidOf(pick.track, pick.publication) || 'unknown'
  const existing = host.querySelector('video')
  const currentSid = host.dataset.castTrackSid ?? ''

  // Same track already mounted — do not remount (no flicker) and do **not** stomp
  // mute/volume (UI mute toggle owns those after first attach). Still attach late audio.
  if (existing instanceof HTMLVideoElement && currentSid === nextSid && existing.isConnected) {
    if (existing.paused) void existing.play().catch(() => {})
    ensureCompanionStreamAudioOnHost(room, host, pick.identity, opts, true)
    return true
  }

  host.replaceChildren()
  try {
    // Detach other elements for this track, keep identity for re-attach below.
    pick.track.detach().forEach((n) => {
      if (n !== existing) n.remove()
    })
  } catch {
    /* ignore */
  }
  const el = pick.track.attach()
  if (!(el instanceof HTMLVideoElement)) return false
  el.autoplay = true
  el.playsInline = true
  el.setAttribute('playsinline', '')
  el.setAttribute('webkit-playsinline', '')
  el.className = 'scene-watch-cast-stage__video'
  const muted = opts?.muted === true
  el.muted = muted
  el.volume = muted ? 0 : Math.min(1, Math.max(0, opts?.volume ?? 1))
  el.controls = opts?.controls === true
  host.dataset.castTrackSid = nextSid
  host.appendChild(el)
  void el.play().catch(() => {})
  // OBS / Cast publish audio as a second track — video-only attach was silent on landing.
  ensureCompanionStreamAudioOnHost(room, host, pick.identity, opts, false)
  return true
}

/** Stop and detach cast video from a host (close watch mode). */
export function clearCastVideoHost(host: HTMLElement): void {
  host.querySelectorAll('video, audio').forEach((node) => {
    const media = node as HTMLMediaElement
    try {
      media.pause()
      media.muted = true
      media.volume = 0
      media.srcObject = null
      media.removeAttribute('src')
      media.load()
    } catch {
      /* ignore */
    }
  })
  delete host.dataset.castTrackSid
  host.replaceChildren()
}
