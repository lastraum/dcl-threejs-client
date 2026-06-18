import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBVideoEvent } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/video_event.gen'
import type { PBVideoPlayer } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/video_player.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { ResolvedScene } from '../dcl/content/types'
import { VS_NONE, type VideoStateValue } from './videoConstants'
import { WebVideoPlayer } from './WebVideoPlayer'

type DecoderEntry = {
  player: WebVideoPlayer
  lastSpecKey: string
  lastAppliedPlaying: boolean | undefined
  lastState: VideoStateValue
  lastOffset: number
  lastLength: number
}

/** ECS VideoPlayer → HTML decoders (one per playing entity); grow-only VideoEvent back to mirror. */
export class VideoPlayerBridge {
  private readonly decoders = new Map<Entity, DecoderEntry>()
  private userGestureUnlocked = false
  private eventTimestamp = 1
  /** Set after pointer-deliver-done until a VideoPlayer toggle is applied. */
  private pendingUserVideoToggle = false
  private pendingUserVideoToggleFrames = 0

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly scene: ResolvedScene,
    /** Source-capture each VideoEvent append for the outbound CrdtEncoder. */
    private readonly recordAppend?: (componentId: number, entity: Entity, value: unknown) => void,
    /** Source-capture VideoPlayer LWW PUTs (playing sync on natural end). */
    private readonly recordLww?: (componentId: number, entity: Entity, value: unknown) => void
  ) {}

  /** Push pending VideoPlayer LWW PUTs to the scene worker (no pointer-await guard). */
  onLwwFlush?: () => void

  /** Scene pointer delivery finished — next VideoPlayer change is a user toggle. */
  notifyUserPointerDelivered(): void {
    this.pendingUserVideoToggle = true
    this.pendingUserVideoToggleFrames = 12
  }

  setUserGestureUnlocked(unlocked: boolean): void {
    if (this.userGestureUnlocked === unlocked) return
    this.userGestureUnlocked = unlocked
    for (const entry of this.decoders.values()) {
      entry.player.setUserGestureUnlocked(unlocked)
    }
  }

  getTexture(entity: Entity): THREE.VideoTexture | null {
    const entry = this.decoders.get(entity)
    if (!entry?.player.hasRenderableFrame()) return null
    return entry.player.texture
  }

  /** Invalidate material cache for entities referencing this video player. */
  onTextureReady?: (videoPlayerEntity: Entity) => void

  sync(view: ProjectionView): void {
    const { VideoPlayer, VisibilityComponent } = this.ecs
    const active = new Set<Entity>()
    const fromUserToggle = this.pendingUserVideoToggle
    let userToggleConsumed = false

    for (const [entity, spec] of view.getEntitiesWith(VideoPlayer)) {
      active.add(entity)
      this.ensureDecoder(entity)
      const entry = this.decoders.get(entity)
      if (!entry) continue

      const visible =
        !VisibilityComponent.has(entity) ||
        VisibilityComponent.get(entity).visible !== false
      entry.player.setVisibilityPaused(!visible)
      if (this.applySpec(entity, spec, fromUserToggle)) {
        userToggleConsumed = true
      }
    }

    if (userToggleConsumed) {
      this.pendingUserVideoToggle = false
      this.pendingUserVideoToggleFrames = 0
    } else if (this.pendingUserVideoToggle && this.pendingUserVideoToggleFrames > 0) {
      this.pendingUserVideoToggleFrames--
      if (this.pendingUserVideoToggleFrames === 0) {
        this.pendingUserVideoToggle = false
      }
    }

    for (const entity of [...this.decoders.keys()]) {
      if (!active.has(entity)) this.removeDecoder(entity)
    }
  }

  update(tickNumber: number, view: ProjectionView): void {
    const { VideoPlayer, VideoEvent } = this.ecs

    for (const [entity] of view.getEntitiesWith(VideoPlayer)) {
      const entry = this.decoders.get(entity)
      if (!entry) continue

      const state = entry.player.getVideoState()
      const currentOffset = entry.player.getCurrentOffset()
      const videoLength = entry.player.getVideoLength()

      const stateChanged = state !== entry.lastState
      const offsetChanged = Math.abs(currentOffset - entry.lastOffset) > 0.05
      const lengthChanged = Math.abs(videoLength - entry.lastLength) > 0.05 && videoLength > 0

      if (!stateChanged && !offsetChanged && !lengthChanged) continue

      entry.lastState = state
      entry.lastOffset = currentOffset
      entry.lastLength = videoLength

      const event: PBVideoEvent = {
        timestamp: this.eventTimestamp++,
        tickNumber,
        currentOffset,
        videoLength,
        state
      }
      VideoEvent.addValue(entity, event)
      this.recordAppend?.(VideoEvent.componentId, entity, event)
    }
  }

  disposeEntity(entity: Entity): void {
    this.removeDecoder(entity)
  }

  dispose(): void {
    for (const entity of [...this.decoders.keys()]) {
      this.removeDecoder(entity)
    }
  }

  private ensureDecoder(entity: Entity): void {
    if (this.decoders.has(entity)) return
    const player = new WebVideoPlayer(this.scene)
    player.setUserGestureUnlocked(this.userGestureUnlocked)
    player.onFrameReady = () => this.onTextureReady?.(entity)
    player.onNaturalEnd = () => this.syncPlayingToEcs(entity, false)
    this.decoders.set(entity, {
      player,
      lastSpecKey: '',
      lastAppliedPlaying: undefined,
      lastState: VS_NONE,
      lastOffset: -1,
      lastLength: -1
    })
    this.onTextureReady?.(entity)
  }

  /** Keep scene worker + projection `playing` aligned with decoder (e.g. after natural end). */
  private syncPlayingToEcs(entity: Entity, playing: boolean): void {
    const { VideoPlayer } = this.ecs
    const spec = VideoPlayer.getOrNull(entity) as PBVideoPlayer | null
    const entry = this.decoders.get(entity)
    if (!spec || !entry) return
    const currentPlaying = spec.playing !== false
    if (currentPlaying === playing) return

    const next: PBVideoPlayer = {
      ...spec,
      playing,
      position: entry.player.getCurrentOffset()
    }
    VideoPlayer.createOrReplace(entity, next)
    entry.lastAppliedPlaying = playing
    // Do not cache lastSpecKey — worker may still have playing=true until LWW inject lands.
    entry.player.applySpec(next, { fromEcsSync: true })
    this.recordLww?.(VideoPlayer.componentId, entity, next)
    this.onLwwFlush?.()
  }

  private applySpec(
    entity: Entity,
    spec: PBVideoPlayer,
    fromUserToggle = false
  ): boolean {
    const entry = this.decoders.get(entity)
    if (!entry) return false
    const ecsPlaying = spec.playing !== false
    const specKey = JSON.stringify(spec)
    const bridgePlayingChanged =
      entry.lastAppliedPlaying !== undefined && ecsPlaying !== entry.lastAppliedPlaying
    const playerPlayingChanged = entry.player.wouldEcsPlayingChange(ecsPlaying)
    const playingChanged = bridgePlayingChanged || playerPlayingChanged
    const needsEndedReplay = entry.player.needsReplayAfterEnd(playerPlayingChanged, fromUserToggle)
    if (entry.lastSpecKey === specKey && !playingChanged && !needsEndedReplay) return false
    entry.lastSpecKey = specKey
    entry.lastAppliedPlaying = ecsPlaying
    entry.player.applySpec(spec, { fromUserToggle })
    this.onTextureReady?.(entity)
    return fromUserToggle && playingChanged
  }

  private removeDecoder(entity: Entity): void {
    const entry = this.decoders.get(entity)
    if (!entry) return
    entry.player.dispose()
    this.decoders.delete(entity)
  }
}