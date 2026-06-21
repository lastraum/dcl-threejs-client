import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { PBAudioEvent } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_event.gen'
import type { PBAudioSource } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_source.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { ResolvedScene } from '../dcl/content/types'
import { soundSettings, volumeToGain } from '../rendering/SoundSettings'
import { AudioBufferCache } from './AudioBufferCache'
import { MS_NONE, type MediaStateValue } from './audioConstants'
import { SceneAudioPlayer } from './SceneAudioPlayer'
import { resolveSpatialAudioAttach, type SpatialAudioAnchors } from './spatialAudioParent'

type PlayerEntry = {
  player: SceneAudioPlayer
  lastSpecKey: string
  lastAppliedPlaying: boolean | undefined
  lastGlobal: boolean
  lastState: MediaStateValue
}

/** ECS AudioSource → THREE.Audio decoders; grow-only AudioEvent back to mirror. */
export class AudioSourceBridge {
  private readonly players = new Map<Entity, PlayerEntry>()
  private readonly cache: AudioBufferCache
  private readonly listener: THREE.AudioListener
  private userGestureUnlocked = false
  private eventTimestamp = 1
  private readonly unsubscribeSoundSettings: () => void

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly scene: ResolvedScene,
    private readonly view: ProjectionView,
    private readonly getEntityNodes: () => Map<Entity, THREE.Group>,
    private readonly getSpatialAnchors: () => SpatialAudioAnchors | null,
    camera: THREE.Camera,
    /** Source-capture each AudioEvent append for the outbound CrdtEncoder. */
    private readonly recordAppend?: (componentId: number, entity: Entity, value: unknown) => void,
    /** Source-capture AudioSource LWW PUTs (playing sync on natural end). */
    private readonly recordLww?: (componentId: number, entity: Entity, value: unknown) => void
  ) {
    this.listener = new THREE.AudioListener()
    this.cache = new AudioBufferCache(() => this.listener.context)
    camera.add(this.listener)
    this.applyMasterVolume(soundSettings.get().masterVolume)
    this.unsubscribeSoundSettings = soundSettings.subscribe((state) => {
      this.applyMasterVolume(state.masterVolume)
      for (const entry of this.players.values()) entry.player.refreshVolume()
    })
  }

  /** Push pending AudioSource LWW PUTs to the scene worker (no pointer-await guard). */
  onLwwFlush?: () => void

  getListener(): THREE.AudioListener {
    return this.listener
  }

  setUserGestureUnlocked(unlocked: boolean): void {
    if (this.userGestureUnlocked === unlocked) return
    this.userGestureUnlocked = unlocked
    for (const entry of this.players.values()) {
      entry.player.setUserGestureUnlocked(unlocked)
    }
  }

  sync(view: ProjectionView): void {
    const { AudioSource, VisibilityComponent, Transform } = this.ecs
    const active = new Set<Entity>()

    for (const [entity, spec] of view.getEntitiesWith(AudioSource)) {
      active.add(entity)
      this.ensurePlayer(entity, spec)
      const entry = this.players.get(entity)
      if (!entry) continue

      const global = spec.global === true
      const attach = global
        ? null
        : resolveSpatialAudioAttach(
            entity,
            view,
            Transform,
            this.getEntityNodes,
            this.getSpatialAnchors()
          )

      if (entry.lastGlobal !== global) {
        entry.lastGlobal = global
        entry.player.setSpatialMode(global, attach?.parent, attach?.localTransform)
        entry.lastSpecKey = ''
      }

      if (global) {
        entry.player.detachFromScene()
      } else if (attach) {
        entry.player.attachToParent(attach.parent, attach.localTransform)
      }

      const visible =
        !VisibilityComponent.has(entity) ||
        VisibilityComponent.get(entity).visible !== false
      entry.player.setVisibilityPaused(!visible)
      this.applySpec(entity, spec)
    }

    for (const entity of [...this.players.keys()]) {
      if (!active.has(entity)) this.removePlayer(entity)
    }
  }

  update(_tickNumber: number, view: ProjectionView): void {
    const { AudioSource, AudioEvent } = this.ecs

    for (const [entity] of view.getEntitiesWith(AudioSource)) {
      const entry = this.players.get(entity)
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
    this.removePlayer(entity)
  }

  dispose(): void {
    for (const entity of [...this.players.keys()]) {
      this.removePlayer(entity)
    }
    this.unsubscribeSoundSettings()
    this.cache.clear()
    this.listener.parent?.remove(this.listener)
  }

  private applyMasterVolume(percent: number): void {
    this.listener.gain.gain.value = volumeToGain(percent)
  }

  private ensurePlayer(entity: Entity, spec: PBAudioSource): void {
    if (this.players.has(entity)) return
    const global = spec.global === true
    const attach = global
      ? null
      : resolveSpatialAudioAttach(
          entity,
          this.view,
          this.ecs.Transform,
          this.getEntityNodes,
          this.getSpatialAnchors()
        )
    const player = new SceneAudioPlayer(
      this.listener,
      this.scene,
      this.cache,
      global,
      attach?.parent,
      attach?.localTransform
    )
    player.setUserGestureUnlocked(this.userGestureUnlocked)
    player.onNaturalEnd = () => this.syncPlayingToEcs(entity, false)
    this.players.set(entity, {
      player,
      lastSpecKey: '',
      lastAppliedPlaying: undefined,
      lastGlobal: global,
      lastState: MS_NONE
    })
  }

  private syncPlayingToEcs(entity: Entity, playing: boolean): void {
    const { AudioSource } = this.ecs
    const spec = AudioSource.getOrNull(entity) as PBAudioSource | null
    const entry = this.players.get(entity)
    if (!spec || !entry) return

    const currentPlaying = spec.playing !== false
    entry.lastAppliedPlaying = playing
    if (currentPlaying === playing) {
      entry.player.alignEcsPlaying(playing)
      return
    }

    const next: PBAudioSource = {
      ...spec,
      playing,
      currentTime: undefined
    }
    AudioSource.createOrReplace(entity, next)
    entry.player.applySpec(next, { fromEcsSync: true })
    this.recordLww?.(AudioSource.componentId, entity, next)
    this.onLwwFlush?.()
  }

  private applySpec(entity: Entity, spec: PBAudioSource): void {
    const entry = this.players.get(entity)
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

  private removePlayer(entity: Entity): void {
    const entry = this.players.get(entity)
    if (!entry) return
    entry.player.dispose()
    this.players.delete(entity)
  }
}