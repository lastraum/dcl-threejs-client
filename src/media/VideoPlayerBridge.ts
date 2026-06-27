import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBVideoEvent } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/video_event.gen'
import type { PBVideoPlayer } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/video_player.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { ResolvedScene } from '../dcl/content/types'
import { VS_NONE, type VideoStateValue } from './videoConstants'
import type { LiveKitVideoBinder } from './WebVideoPlayer'
import { WebVideoPlayer } from './WebVideoPlayer'
import { resolveSpatialAudioAttach, type SpatialAudioAnchors } from './spatialAudioParent'
import { soundSettings } from '../rendering/SoundSettings'
import { skipSceneVideoPlayers } from '../client/devFlags'
import { clientDebugLog } from '../client/debug/ClientDebugLog'

type DecoderEntry = {
  player: WebVideoPlayer
  lastSpecKey: string
  lastAppliedPlaying: boolean | undefined
  lastSpatial: boolean
  lastSpatialMin: number
  lastSpatialMax: number
  lastState: VideoStateValue
  lastOffset: number
  lastLength: number
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
  private readonly unsubscribeSoundSettings: () => void

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly scene: ResolvedScene,
    private readonly getEntityNodes: () => Map<Entity, THREE.Group>,
    private readonly getSpatialAnchors: () => SpatialAudioAnchors | null,
    private readonly getLiveKitBinder: () => LiveKitVideoBinder | null,
    private readonly recordAppend?: (componentId: number, entity: Entity, value: unknown) => void,
    private readonly recordLww?: (componentId: number, entity: Entity, value: unknown) => void
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

  getTexture(entity: Entity): THREE.Texture | null {
    const entry = this.decoders.get(entity)
    if (!entry?.player.canAttachTexture()) return null
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
    const { VideoPlayer, VisibilityComponent, Transform } = this.ecs
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

      if (this.applySpec(entity, spec, fromUserToggle)) {
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
    if (skipSceneVideoPlayers()) return
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
    this.unsubscribeSoundSettings()
    for (const entity of [...this.decoders.keys()]) {
      this.removeDecoder(entity)
    }
  }

  private ensureDecoder(entity: Entity): void {
    if (this.decoders.has(entity)) return
    const player = new WebVideoPlayer(this.scene, this.getLiveKitBinder())
    player.setAudioListener(this.listener)
    player.setUserGestureUnlocked(this.userGestureUnlocked)
    player.onFrameReady = () => this.onTextureReady?.(entity)
    player.onNaturalEnd = () => this.syncPlayingToEcs(entity, false)
    player.onReplayStarted = () => this.syncPlayingToEcs(entity, true)
    this.decoders.set(entity, {
      player,
      lastSpecKey: '',
      lastAppliedPlaying: undefined,
      lastSpatial: false,
      lastSpatialMin: 0,
      lastSpatialMax: 60,
      lastState: VS_NONE,
      lastOffset: -1,
      lastLength: -1
    })
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
    return fromUserToggle && (playingChanged || entry.player.isHoldingAtEnd())
  }

  private removeDecoder(entity: Entity): void {
    const entry = this.decoders.get(entity)
    if (!entry) return
    entry.player.dispose()
    this.decoders.delete(entity)
  }
}