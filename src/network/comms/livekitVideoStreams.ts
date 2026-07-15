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

/** Unity `PRESENTATION_BOT_IDENTITY_PREFIX` — DCL Cast slide/presentation publisher. */
export const PRESENTATION_BOT_IDENTITY_PREFIX = 'presentation-bot:'

export function isPresentationBotIdentity(identity: string | undefined | null): boolean {
  return (identity ?? '').toLowerCase().startsWith(PRESENTATION_BOT_IDENTITY_PREFIX)
}

/**
 * Priority for scene `livekit-video://current-stream` (Unity LivekitPlayer.BestInitialVideoKey):
 * presentation bot → screen share → camera → other/ingress (unknown).
 */
function videoSourceTier(source: Track.Source, identity: string): number {
  if (isPresentationBotIdentity(identity)) return -1
  if (source === Track.Source.ScreenShare) return 0
  if (source === Track.Source.Camera) return 1
  return 2 // unknown / RTMP ingress-style
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
    pick.publication.trackSid?.trim() ||
    (typeof pick.track.sid === 'string' ? pick.track.sid.trim() : '') ||
    'unknown'
  const existing = host.querySelector('video')
  const currentSid = host.dataset.castTrackSid ?? ''

  // Same track already mounted — do not remount (no flicker) and do **not** stomp
  // mute/volume (UI mute toggle owns those after first attach).
  if (existing instanceof HTMLVideoElement && currentSid === nextSid && existing.isConnected) {
    if (existing.paused) void existing.play().catch(() => {})
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
