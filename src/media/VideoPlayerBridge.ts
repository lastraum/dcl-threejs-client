import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBVideoEvent } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/video_event.gen'
import type { PBVideoPlayer } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/video_player.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { ResolvedScene } from '../dcl/content/types'
import {
  VS_BUFFERING,
  VS_NONE,
  VS_PLAYING,
  VS_READY,
  type VideoStateValue
} from './videoConstants'
import type { LiveKitVideoBinder } from './WebVideoPlayer'
import { WebVideoPlayer } from './WebVideoPlayer'
import { resolveSpatialAudioAttach, type SpatialAudioAnchors } from './spatialAudioParent'
import { soundSettings } from '../rendering/SoundSettings'
import { skipSceneVideoPlayers } from '../client/devFlags'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
type DecoderEntry = {
  player: WebVideoPlayer
  lastSpecKey: string
  /** Last ECS VideoPlayer.src — explicit change detection for mp4 ↔ m3u8 swaps. */
  lastSrc: string
  lastAppliedPlaying: boolean | undefined
  lastSpatial: boolean
  lastSpatialMin: number
  lastSpatialMax: number
  lastState: VideoStateValue
  lastOffset: number
  lastLength: number
  /** Wall-clock of last VideoEvent append — throttle offset spam to worker. */
  lastEventAtMs: number
}

/** ECS VideoPlayer → HTML decoders (one per playing entity); grow-only VideoEvent back to mirror. */
export class VideoPlayerBridge {
  private readonly decoders = new Map<Entity, DecoderEntry>()
  private userGestureUnlocked = false
  private eventTimestamp = 1
  private pendingUserVideoToggle = false
  private pendingUserVideoToggleFrames = 0
  private listener: THREE.AudioListener | null = null
  private loggedVideoSkip = false
  /**
   * FocusOwner gate — when false, dispose all decoders and ignore ECS playing.
   * Does not write playing=false back to ECS so promote can resume intent.
   */
  private mediaEnabled = true
  private readonly unsubscribeSoundSettings: () => void

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly scene: ResolvedScene,
    private readonly getEntityNodes: () => Map<Entity, THREE.Group>,
    private readonly getSpatialAnchors: () => SpatialAudioAnchors | null,
    private readonly getLiveKitBinder: () => LiveKitVideoBinder | null,
    private readonly recordAppend?: (componentId: number, entity: Entity, value: unknown) => void,
    private readonly recordLww?: (componentId: number, entity: Entity, value: unknown) => void,
    /**
     * Scene LiveKit has remote video (stream-key / Cast). Used only to **hold** an already
     * activated `livekit-video://` src against late CRDT defaultURL — not to override
     * main.composite / MessageBus / future SyncComponents VideoPlayer state.
     */
    private readonly getRemoteVideoLive: () => boolean = () => false
  ) {
    this.unsubscribeSoundSettings = soundSettings.subscribe(() => {
      for (const entry of this.decoders.values()) entry.player.refreshVolume()
    })
  }

  onLwwFlush?: () => void
  onTextureReady?: (videoPlayerEntity: Entity) => void

  setAudioListener(listener: THREE.AudioListener | null): void {
    this.listener = listener
    for (const entry of this.decoders.values()) {
      entry.player.setAudioListener(listener)
    }
  }

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

  /**
   * FocusOwner media gate. false → hard-stop video (dispose decoders); true → next sync may recreate.
   * Never mutates ECS VideoPlayer.playing.
   */
  setMediaEnabled(enabled: boolean): void {
    if (this.mediaEnabled === enabled) return
    this.mediaEnabled = enabled
    if (!enabled) {
      for (const entity of [...this.decoders.keys()]) {
        this.removeDecoder(entity)
      }
    }
  }

  isMediaEnabled(): boolean {
    return this.mediaEnabled
  }

  getTexture(entity: Entity): THREE.Texture | null {
    const entry = this.decoders.get(entity)
    if (!entry) return null
    // Always bind the canvas map (black idle / loading, or live frames).
    // Gating on canAttachTexture left materials with null map → default white albedo.
    return entry.player.texture
  }

  private drainIfVideoSkipped(): boolean {
    if (!skipSceneVideoPlayers()) return false
    if (!this.loggedVideoSkip) {
      this.loggedVideoSkip = true
      clientDebugLog.log(
        'client',
        'Scene VideoPlayer disabled (?novideo) — skips theatre LiveKit screen decoders'
      )
    }
    if (this.decoders.size) {
      for (const entity of [...this.decoders.keys()]) this.removeDecoder(entity)
    }
    return true
  }

  sync(view: ProjectionView): void {
    if (this.drainIfVideoSkipped()) return
    if (!this.mediaEnabled) {
      if (this.decoders.size) {
        for (const entity of [...this.decoders.keys()]) this.removeDecoder(entity)
      }
      return
    }
    const { VideoPlayer, VisibilityComponent, Transform } = this.ecs
    const active = new Set<Entity>()
    const fromUserToggle = this.pendingUserVideoToggle
    let userToggleConsumed = false
    const remoteLive = this.getRemoteVideoLive()

    for (const [entity, spec] of view.getEntitiesWith(VideoPlayer)) {
      active.add(entity)
      this.ensureDecoder(entity)
      const entry = this.decoders.get(entity)
      if (!entry) continue

      const visible =
        !VisibilityComponent.has(entity) ||
        VisibilityComponent.get(entity).visible !== false
      entry.player.setVisibilityPaused(!visible)

      const spatial = spec.spatial === true
      const spatialMin = spec.spatialMinDistance ?? 0
      const spatialMax = spec.spatialMaxDistance ?? 60
      const attach = spatial
        ? resolveSpatialAudioAttach(
            entity,
            view,
            Transform,
            this.getEntityNodes,
            this.getSpatialAnchors()
          )
        : null
      const spatialChanged =
        entry.lastSpatial !== spatial ||
        entry.lastSpatialMin !== spatialMin ||
        entry.lastSpatialMax !== spatialMax

      if (spatialChanged) {
        entry.lastSpatial = spatial
        entry.lastSpatialMin = spatialMin
        entry.lastSpatialMax = spatialMax
        entry.player.setSpatialAudio(
          spatial,
          spatialMin,
          spatialMax,
          attach?.parent,
          attach?.localTransform
        )
        entry.lastSpecKey = ''
      } else if (spatial && attach) {
        entry.player.attachSpatialSound(attach.parent, attach.localTransform)
        entry.player.applySpatialDistances(spatialMin, spatialMax)
      }

      // Source of truth: ECS VideoPlayer (main.composite spawn + scene/Admin mutations;
      // later SyncComponents). Client only decodes whatever `spec.src` says.
      if (this.applySpec(entity, spec, fromUserToggle, remoteLive)) {
        userToggleConsumed = true
      }
    }

    if (!userToggleConsumed && fromUserToggle) {
      for (const [entity, entry] of this.decoders) {
        if (!entry.player.isHoldingAtEnd()) continue
        entry.player.replayFromUserClick()
        entry.lastAppliedPlaying = true
        this.onTextureReady?.(entity)
        userToggleConsumed = true
        break
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
    if (!this.mediaEnabled) return
    if (skipSceneVideoPlayers()) return
    const { VideoPlayer, VideoEvent } = this.ecs

    for (const [entity] of view.getEntitiesWith(VideoPlayer)) {
      const entry = this.decoders.get(entity)
      if (!entry) continue

      // Keep progressive / HLS playback alive through stalls and aborted seeks.
      entry.player.tickPlayback()

      const state = entry.player.getVideoState()
      const currentOffset = entry.player.getCurrentOffset()
      const videoLength = entry.player.getVideoLength()
      const now = performance.now()

      // Soft PLAYING↔BUFFERING thrash: collapse for worker events only (texture
      // upload is independent — keep SCENE_VIDEO_MAX_FPS watchable).
      const softPlayingLike = (s: number) =>
        s === VS_PLAYING || s === VS_BUFFERING || s === VS_READY
      const hardChange =
        state !== entry.lastState &&
        !(softPlayingLike(state) && softPlayingLike(entry.lastState))
      const softChange =
        state !== entry.lastState &&
        softPlayingLike(state) &&
        softPlayingLike(entry.lastState) &&
        now - entry.lastEventAtMs > 1000
      const stateChanged = hardChange || softChange
      const lengthChanged = Math.abs(videoLength - entry.lastLength) > 0.25 && videoLength > 0
      // Offset-only heartbeats: max ~1Hz. Every 400ms was flooding grow-only CRDT during
      // fishing cast (renderer-append-deliver videoEvent=1) and stealing frame time.
      const offsetChanged =
        Math.abs(currentOffset - entry.lastOffset) > 1.0 && now - entry.lastEventAtMs > 1000

      if (!hardChange && now - entry.lastEventAtMs < 350) continue

      if (!stateChanged && !offsetChanged && !lengthChanged) continue

      entry.lastState = state
      entry.lastOffset = currentOffset
      entry.lastLength = videoLength
      entry.lastEventAtMs = now

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
    this.unsubscribeSoundSettings()
    for (const entity of [...this.decoders.keys()]) {
      this.removeDecoder(entity)
    }
  }

  private ensureDecoder(entity: Entity): void {
    if (this.decoders.has(entity)) return
    // Live getter — binder/scene room may appear after the first VideoPlayer entity is seen.
    const player = new WebVideoPlayer(this.scene, () => this.getLiveKitBinder())
    player.setAudioListener(this.listener)
    player.setUserGestureUnlocked(this.userGestureUnlocked)
    player.onFrameReady = () => this.onTextureReady?.(entity)
    player.onNaturalEnd = () => this.syncPlayingToEcs(entity, false)
    player.onReplayStarted = () => this.syncPlayingToEcs(entity, true)
    this.decoders.set(entity, {
      player,
      lastSpecKey: '',
      lastSrc: '',
      lastAppliedPlaying: undefined,
      lastSpatial: false,
      lastSpatialMin: 0,
      lastSpatialMax: 60,
      lastState: VS_NONE,
      lastOffset: -1,
      lastLength: -1,
      lastEventAtMs: 0
    })
    // Bind black placeholder immediately so video screens never render white.
    this.onTextureReady?.(entity)
  }

  private syncPlayingToEcs(entity: Entity, playing: boolean): void {
    const { VideoPlayer } = this.ecs
    const spec = VideoPlayer.getOrNull(entity) as PBVideoPlayer | null
    const entry = this.decoders.get(entity)
    if (!spec || !entry) return
    const currentPlaying = spec.playing !== false
    entry.lastAppliedPlaying = playing
    if (currentPlaying === playing) {
      entry.player.alignEcsPlaying(playing)
      return
    }

    const next: PBVideoPlayer = {
      ...spec,
      playing,
      position: entry.player.getCurrentOffset()
    }
    VideoPlayer.createOrReplace(entity, next)
    entry.player.applySpec(next, {
      fromEcsSync: true,
      liveKitRemoteLive: this.getRemoteVideoLive()
    })
    this.recordLww?.(VideoPlayer.componentId, entity, next)
    this.onLwwFlush?.()
  }

  private applySpec(
    entity: Entity,
    spec: PBVideoPlayer,
    fromUserToggle = false,
    liveKitRemoteLive = false
  ): boolean {
    const entry = this.decoders.get(entity)
    if (!entry) return false
    const ecsPlaying = spec.playing !== false
    // Explicit src tracking — force re-apply on mp4 ↔ m3u8 ↔ livekit even if other
    // fields hash the same after soft-hold / CRDT noise.
    const src = (spec.src ?? '').trim()
    const srcChanged = src !== entry.lastSrc
    if (srcChanged) {
      entry.lastSrc = src
      entry.lastSpecKey = ''
    }
    // Include live flag so we re-apply when stream-key/Cast starts/stops without ECS src change.
    const specKey = `${liveKitRemoteLive ? '1' : '0'}:${JSON.stringify(spec)}`
    const bridgePlayingChanged =
      entry.lastAppliedPlaying !== undefined && ecsPlaying !== entry.lastAppliedPlaying
    const playerPlayingChanged = entry.player.wouldEcsPlayingChange(ecsPlaying)
    const playingChanged = bridgePlayingChanged || playerPlayingChanged
    const needsEndedReplay = entry.player.needsReplayAfterEnd(playerPlayingChanged, fromUserToggle)
    if (entry.lastSpecKey === specKey && !playingChanged && !needsEndedReplay && !srcChanged) {
      return false
    }
    entry.lastSpecKey = specKey
    entry.lastAppliedPlaying = ecsPlaying
    entry.player.applySpec(spec, { fromUserToggle, liveKitRemoteLive })
    // Rebind materials after src swap / idle black / first frame.
    this.onTextureReady?.(entity)
    return fromUserToggle && (playingChanged || entry.player.isHoldingAtEnd())
  }

  private removeDecoder(entity: Entity): void {
    const entry = this.decoders.get(entity)
    if (!entry) return
    entry.player.dispose()
    this.decoders.delete(entity)
  }
}