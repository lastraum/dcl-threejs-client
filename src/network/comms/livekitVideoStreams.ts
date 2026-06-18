import { Track, type Participant, type Room } from 'livekit-client'
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

function collectFromParticipant(participant: Participant, out: ActiveVideoStream[]): void {
  const identity = participant.identity?.trim()
  if (!identity) return

  for (const publication of participant.trackPublications.values()) {
    if (publication.kind !== Track.Kind.Video) continue
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