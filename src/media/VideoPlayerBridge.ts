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
  lastState: VideoStateValue
  lastOffset: number
  lastLength: number
}

/** ECS VideoPlayer → HTML decoder; grow-only VideoEvent back to mirror. */
export class VideoPlayerBridge {
  private decoder: DecoderEntry | null = null
  private activeEntity: Entity | null = null
  private readonly lastPlaying = new Map<Entity, boolean>()
  private userGestureUnlocked = false
  private eventTimestamp = 1

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly scene: ResolvedScene,
    /** Source-capture each VideoEvent append for the outbound CrdtEncoder. */
    private readonly recordAppend?: (componentId: number, entity: Entity, value: unknown) => void
  ) {}

  setUserGestureUnlocked(unlocked: boolean): void {
    if (this.userGestureUnlocked === unlocked) return
    this.userGestureUnlocked = unlocked
    this.decoder?.player.setUserGestureUnlocked(unlocked)
  }

  getTexture(entity: Entity): THREE.VideoTexture | null {
    if (this.activeEntity !== entity) return null
    return this.decoder?.player.texture ?? null
  }

  /** Invalidate material cache for entities referencing this video player. */
  onTextureReady?: (videoPlayerEntity: Entity) => void

  sync(view: ProjectionView): void {
    const { VideoPlayer, VisibilityComponent } = this.ecs
    const active = new Set<Entity>()

    for (const [entity, spec] of view.getEntitiesWith(VideoPlayer)) {
      active.add(entity)
      const playing = spec.playing !== false
      const wasPlaying = this.lastPlaying.get(entity) ?? false
      if (playing && (!wasPlaying || this.activeEntity !== entity)) {
        this.setActiveEntity(entity, spec)
      }
      this.lastPlaying.set(entity, playing)

      if (entity === this.activeEntity && !playing) {
        this.clearActiveEntity()
      }
    }

    if (this.activeEntity === null) {
      const next = this.pickFallbackActive(view)
      if (next !== null) this.setActiveEntity(next, VideoPlayer.get(next))
    }

    if (this.activeEntity !== null && active.has(this.activeEntity)) {
      const spec = VideoPlayer.get(this.activeEntity)
      const visible =
        !VisibilityComponent.has(this.activeEntity) ||
        VisibilityComponent.get(this.activeEntity).visible !== false
      this.decoder?.player.setVisibilityPaused(!visible)
      this.applySpec(this.activeEntity, spec)
    }

    for (const entity of this.lastPlaying.keys()) {
      if (!active.has(entity)) {
        this.lastPlaying.delete(entity)
        if (this.activeEntity === entity) this.clearActiveEntity()
      }
    }
  }

  update(tickNumber: number, view: ProjectionView): void {
    const { VideoPlayer, VideoEvent } = this.ecs

    for (const [entity] of view.getEntitiesWith(VideoPlayer)) {
      const entry = entity === this.activeEntity ? this.decoder : null
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
    if (this.activeEntity !== entity) return
    this.clearActiveEntity()
  }

  dispose(): void {
    this.clearActiveEntity()
    this.lastPlaying.clear()
  }

  private pickFallbackActive(view: ProjectionView): Entity | null {
    const { VideoPlayer, VisibilityComponent } = this.ecs
    let pick: Entity | null = null
    for (const [entity, spec] of view.getEntitiesWith(VideoPlayer)) {
      if (spec.playing === false) continue
      if (VisibilityComponent.has(entity) && VisibilityComponent.get(entity).visible === false) continue
      pick = entity
    }
    return pick
  }

  private setActiveEntity(entity: Entity, spec: PBVideoPlayer): void {
    if (this.activeEntity === entity) {
      this.applySpec(entity, spec)
      return
    }

    this.clearActiveEntity()
    this.activeEntity = entity

    const player = new WebVideoPlayer(this.scene)
    player.setUserGestureUnlocked(this.userGestureUnlocked)
    this.decoder = {
      player,
      lastSpecKey: '',
      lastState: VS_NONE,
      lastOffset: -1,
      lastLength: -1
    }
    this.applySpec(entity, spec)
    this.onTextureReady?.(entity)
  }

  private applySpec(entity: Entity, spec: PBVideoPlayer): void {
    if (this.activeEntity !== entity || !this.decoder) return
    const specKey = JSON.stringify(spec)
    if (this.decoder.lastSpecKey === specKey) return
    this.decoder.lastSpecKey = specKey
    this.decoder.player.applySpec(spec)
    this.onTextureReady?.(entity)
  }

  private clearActiveEntity(): void {
    if (this.decoder) {
      this.decoder.player.dispose()
      this.decoder = null
    }
    this.activeEntity = null
  }
}
