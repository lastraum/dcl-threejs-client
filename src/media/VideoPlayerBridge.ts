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

/** ECS VideoPlayer → HTML decoders (one per playing entity); grow-only VideoEvent back to mirror. */
export class VideoPlayerBridge {
  private readonly decoders = new Map<Entity, DecoderEntry>()
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
    for (const entry of this.decoders.values()) {
      entry.player.setUserGestureUnlocked(unlocked)
    }
  }

  getTexture(entity: Entity): THREE.VideoTexture | null {
    return this.decoders.get(entity)?.player.texture ?? null
  }

  /** Invalidate material cache for entities referencing this video player. */
  onTextureReady?: (videoPlayerEntity: Entity) => void

  sync(view: ProjectionView): void {
    const { VideoPlayer, VisibilityComponent } = this.ecs
    const active = new Set<Entity>()

    for (const [entity, spec] of view.getEntitiesWith(VideoPlayer)) {
      active.add(entity)
      const playing = spec.playing !== false
      if (!playing) {
        this.removeDecoder(entity)
        continue
      }

      this.ensureDecoder(entity)
      const entry = this.decoders.get(entity)
      if (!entry) continue

      const visible =
        !VisibilityComponent.has(entity) ||
        VisibilityComponent.get(entity).visible !== false
      entry.player.setVisibilityPaused(!visible)
      this.applySpec(entity, spec)
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
    this.decoders.set(entity, {
      player,
      lastSpecKey: '',
      lastState: VS_NONE,
      lastOffset: -1,
      lastLength: -1
    })
    this.onTextureReady?.(entity)
  }

  private applySpec(entity: Entity, spec: PBVideoPlayer): void {
    const entry = this.decoders.get(entity)
    if (!entry) return
    const specKey = JSON.stringify(spec)
    if (entry.lastSpecKey === specKey) return
    entry.lastSpecKey = specKey
    entry.player.applySpec(spec)
    this.onTextureReady?.(entity)
  }

  private removeDecoder(entity: Entity): void {
    const entry = this.decoders.get(entity)
    if (!entry) return
    entry.player.dispose()
    this.decoders.delete(entity)
  }
}