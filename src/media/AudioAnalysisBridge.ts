import type { Entity } from '@dcl/ecs'
import type { PBAudioAnalysis } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/audio_analysis.gen'
import type { MirrorComponents } from '../bridge/mirrorComponents'
import type { ProjectionView } from '../bridge/ProjectionView'
import {
  sampleAnalyser,
  samplesEqual,
  type AnalysisSample
} from './audioAnalysisMath'
import { WebAudioAnalyserTap } from './WebAudioAnalyserTap'
import type { AudioSourceBridge } from './AudioSourceBridge'
import type { AudioStreamBridge } from './AudioStreamBridge'
import type { VideoPlayerBridge } from './VideoPlayerBridge'

/** Cap concurrent FFT taps — creator docs discourage analysing every source. */
const MAX_ACTIVE_ANALYSERS = 8

type TapEntry = {
  tap: WebAudioAnalyserTap
  lastSample: AnalysisSample | null
}

/**
 * Host fill for core::AudioAnalysis (1212).
 * Same-entity rule: AudioAnalysis + AudioSource | AudioStream | VideoPlayer.
 * Parallel WebAudio analyser → dirty-only LWW PUT (mode/gains preserved from scene).
 */
export class AudioAnalysisBridge {
  private readonly taps = new Map<Entity, TapEntry>()
  private mediaEnabled = true
  private wroteThisFrame = false

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly getAudioSource: () => AudioSourceBridge | null,
    private readonly getAudioStream: () => AudioStreamBridge | null,
    private readonly getVideoPlayer: () => VideoPlayerBridge | null,
    private readonly recordLww?: (componentId: number, entity: Entity, value: unknown) => void
  ) {}

  /** Push pending AudioAnalysis LWW after tick (same pattern as AudioSource.playing). */
  onLwwFlush?: () => void

  setMediaEnabled(enabled: boolean): void {
    if (this.mediaEnabled === enabled) return
    this.mediaEnabled = enabled
    if (!enabled) this.clearAllTaps()
  }

  /**
   * Sample active analyses and write host results.
   * Call after audio/video bridges sync+update so players exist and are playing.
   */
  update(view: ProjectionView): void {
    this.wroteThisFrame = false
    if (!this.mediaEnabled) {
      this.pruneMissing(new Set())
      return
    }

    const { AudioAnalysis } = this.ecs
    const active = new Set<Entity>()
    let activeCount = 0

    for (const [entity, authored] of view.getEntitiesWith(AudioAnalysis)) {
      active.add(entity)
      if (activeCount >= MAX_ACTIVE_ANALYSERS) continue

      const media = this.resolveMedia(entity)
      if (!media) continue

      if (!media.playing) {
        // Explorer: freeze last values while paused/stopped — no write.
        continue
      }

      if (!media.canAnalyse) {
        // HLS / LiveKit: Explorer writes zeros once (not every frame spam).
        this.writeZerosIfNeeded(entity, authored as PBAudioAnalysis)
        continue
      }

      const audio = media.audio
      if (!audio) continue

      let entry = this.taps.get(entity)
      if (!entry) {
        entry = { tap: new WebAudioAnalyserTap(), lastSample: null }
        this.taps.set(entity, entry)
      }

      const analyser = entry.tap.ensure(audio)
      const freq = entry.tap.getFreqData()
      if (!analyser || !freq) continue

      activeCount++
      const sample = sampleAnalyser(
        analyser,
        freq,
        authored.mode ?? 1,
        authored.amplitudeGain,
        authored.bandsGain
      )

      if (entry.lastSample && samplesEqual(entry.lastSample, sample)) continue
      entry.lastSample = sample
      this.writeSample(entity, authored as PBAudioAnalysis, sample)
    }

    this.pruneMissing(active)
    if (this.wroteThisFrame) this.onLwwFlush?.()
  }

  disposeEntity(entity: Entity): void {
    const entry = this.taps.get(entity)
    if (!entry) return
    entry.tap.dispose()
    this.taps.delete(entity)
  }

  dispose(): void {
    this.clearAllTaps()
  }

  private resolveMedia(entity: Entity): {
    playing: boolean
    canAnalyse: boolean
    audio: import('three').Audio | null
  } | null {
    const src = this.getAudioSource()?.getPlayer(entity)
    if (src) {
      return {
        playing: src.isPlayingForAnalysis(),
        canAnalyse: true,
        audio: src.getThreeAudio()
      }
    }
    const stream = this.getAudioStream()?.getPlayer(entity)
    if (stream) {
      return {
        playing: stream.isPlayingForAnalysis(),
        canAnalyse: true,
        audio: stream.getThreeAudio()
      }
    }
    const video = this.getVideoPlayer()?.getPlayer(entity)
    if (video) {
      return {
        playing: video.isPlayingForAnalysis(),
        canAnalyse: video.canProvideAudioAnalysis(),
        audio: video.getThreeAudioForAnalysis()
      }
    }
    return null
  }

  private writeSample(entity: Entity, authored: PBAudioAnalysis, sample: AnalysisSample): void {
    const { AudioAnalysis } = this.ecs
    const next: PBAudioAnalysis = {
      mode: authored.mode ?? 1,
      amplitudeGain: authored.amplitudeGain,
      bandsGain: authored.bandsGain,
      amplitude: sample.amplitude,
      band0: sample.bands[0],
      band1: sample.bands[1],
      band2: sample.bands[2],
      band3: sample.bands[3],
      band4: sample.bands[4],
      band5: sample.bands[5],
      band6: sample.bands[6],
      band7: sample.bands[7]
    }
    AudioAnalysis.createOrReplace(entity, next)
    this.recordLww?.(AudioAnalysis.componentId, entity, next)
    this.wroteThisFrame = true
  }

  private writeZerosIfNeeded(entity: Entity, authored: PBAudioAnalysis): void {
    const entry = this.taps.get(entity)
    const zero: AnalysisSample = {
      amplitude: 0,
      bands: [0, 0, 0, 0, 0, 0, 0, 0]
    }
    if (entry?.lastSample && samplesEqual(entry.lastSample, zero)) return
    if (!entry) {
      this.taps.set(entity, { tap: new WebAudioAnalyserTap(), lastSample: zero })
    } else {
      entry.lastSample = zero
    }
    this.writeSample(entity, authored, zero)
  }

  private pruneMissing(active: Set<Entity>): void {
    for (const entity of [...this.taps.keys()]) {
      if (!active.has(entity)) this.disposeEntity(entity)
    }
  }

  private clearAllTaps(): void {
    for (const entity of [...this.taps.keys()]) this.disposeEntity(entity)
  }
}
