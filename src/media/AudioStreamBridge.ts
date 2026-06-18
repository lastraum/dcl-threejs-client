import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBAudioEvent } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_event.gen'
import type { PBAudioStream } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_stream.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import { soundSettings } from '../rendering/SoundSettings'
import { MS_NONE, type MediaStateValue } from './audioConstants'
import { SceneAudioStreamPlayer } from './SceneAudioStreamPlayer'

type StreamEntry = {
  player: SceneAudioStreamPlayer
  lastSpecKey: string
  lastAppliedPlaying: boolean | undefined
  lastSpatial: boolean
  lastSpatialMin: number
  lastSpatialMax: number
  lastState: MediaStateValue
}

/** ECS AudioStream → HTMLAudioElement decoders; grow-only AudioEvent back to mirror. */
export class AudioStreamBridge {
  private readonly streams = new Map<Entity, StreamEntry>()
  private userGestureUnlocked = false
  private eventTimestamp = 1
  private readonly unsubscribeSoundSettings: () => void

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly getEntityNodes: () => Map<Entity, THREE.Group>,
    private readonly listener: THREE.AudioListener,
    private readonly recordAppend?: (componentId: number, entity: Entity, value: unknown) => void
  ) {
    this.unsubscribeSoundSettings = soundSettings.subscribe(() => {
      for (const entry of this.streams.values()) entry.player.refreshVolume()
    })
  }

  setUserGestureUnlocked(unlocked: boolean): void {
    if (this.userGestureUnlocked === unlocked) return
    this.userGestureUnlocked = unlocked
    for (const entry of this.streams.values()) {
      entry.player.setUserGestureUnlocked(unlocked)
    }
  }

  sync(view: ProjectionView): void {
    const { AudioStream, VisibilityComponent } = this.ecs
    const active = new Set<Entity>()

    for (const [entity, spec] of view.getEntitiesWith(AudioStream)) {
      active.add(entity)
      this.ensureStream(entity, spec)
      const entry = this.streams.get(entity)
      if (!entry) continue

      const spatial = spec.spatial === true
      const spatialMin = spec.spatialMinDistance ?? 0
      const spatialMax = spec.spatialMaxDistance ?? 60
      const spatialChanged =
        entry.lastSpatial !== spatial ||
        entry.lastSpatialMin !== spatialMin ||
        entry.lastSpatialMax !== spatialMax

      if (spatialChanged) {
        entry.lastSpatial = spatial
        entry.lastSpatialMin = spatialMin
        entry.lastSpatialMax = spatialMax
        const parent = this.getEntityNodes().get(entity)
        entry.player.setSpatialMode(spatial, spatialMin, spatialMax, parent)
        entry.lastSpecKey = ''
      } else if (spatial) {
        const parent = this.getEntityNodes().get(entity)
        if (parent) entry.player.attachToParent(parent)
        entry.player.applySpatialDistances(spatialMin, spatialMax)
      }

      const visible =
        !VisibilityComponent.has(entity) ||
        VisibilityComponent.get(entity).visible !== false
      entry.player.setVisibilityPaused(!visible)
      this.applySpec(entity, spec)
    }

    for (const entity of [...this.streams.keys()]) {
      if (!active.has(entity)) this.removeStream(entity)
    }
  }

  update(_tickNumber: number, view: ProjectionView): void {
    const { AudioStream, AudioEvent } = this.ecs

    for (const [entity] of view.getEntitiesWith(AudioStream)) {
      const entry = this.streams.get(entity)
      if (!entry) continue

      const state = entry.player.getMediaState()
      if (state === entry.lastState) continue

      entry.lastState = state
      const event: PBAudioEvent = {
        state,
        timestamp: this.eventTimestamp++
      }
      AudioEvent.addValue(entity, event)
      this.recordAppend?.(AudioEvent.componentId, entity, event)
    }
  }

  disposeEntity(entity: Entity): void {
    this.removeStream(entity)
  }

  dispose(): void {
    for (const entity of [...this.streams.keys()]) {
      this.removeStream(entity)
    }
    this.unsubscribeSoundSettings()
  }

  private ensureStream(entity: Entity, spec: PBAudioStream): void {
    if (this.streams.has(entity)) return
    const spatial = spec.spatial === true
    const parent = spatial ? this.getEntityNodes().get(entity) : undefined
    const player = new SceneAudioStreamPlayer(
      this.listener,
      spatial,
      spec.spatialMinDistance ?? 0,
      spec.spatialMaxDistance ?? 60,
      parent
    )
    player.setUserGestureUnlocked(this.userGestureUnlocked)
    this.streams.set(entity, {
      player,
      lastSpecKey: '',
      lastAppliedPlaying: undefined,
      lastSpatial: spatial,
      lastSpatialMin: spec.spatialMinDistance ?? 0,
      lastSpatialMax: spec.spatialMaxDistance ?? 60,
      lastState: MS_NONE
    })
  }

  private applySpec(entity: Entity, spec: PBAudioStream): void {
    const entry = this.streams.get(entity)
    if (!entry) return

    const ecsPlaying = spec.playing !== false
    const specKey = JSON.stringify(spec)
    const bridgePlayingChanged =
      entry.lastAppliedPlaying !== undefined && ecsPlaying !== entry.lastAppliedPlaying
    const playerPlayingChanged = entry.player.wouldEcsPlayingChange(ecsPlaying)
    const playingChanged = bridgePlayingChanged || playerPlayingChanged
    if (entry.lastSpecKey === specKey && !playingChanged) return

    entry.lastSpecKey = specKey
    entry.lastAppliedPlaying = ecsPlaying
    entry.player.applySpec(spec)
  }

  private removeStream(entity: Entity): void {
    const entry = this.streams.get(entity)
    if (!entry) return
    entry.player.dispose()
    this.streams.delete(entity)
  }
}