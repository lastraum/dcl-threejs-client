import type * as THREE from 'three'
import { ANALYSIS_FFT_SIZE } from './audioAnalysisMath'

/**
 * Parallel WebAudio analyser tap on THREE.Audio.gain (pre-panner).
 * Does not insert series filters — audible graph stays intact.
 */
export class WebAudioAnalyserTap {
  private analyser: AnalyserNode | null = null
  private connectedGain: GainNode | null = null
  private freqData: Uint8Array | null = null
  private audioRef: THREE.Audio | null = null

  /**
   * Ensure analyser is connected to `audio.gain`. Rebinds if the Audio instance changed
   * (spatial mode recreate / clip reload).
   */
  ensure(audio: THREE.Audio): AnalyserNode | null {
    const gain = audio.gain as GainNode | undefined
    const ctx = audio.context as AudioContext | undefined
    if (!gain || !ctx) return null

    if (this.audioRef === audio && this.analyser && this.connectedGain === gain) {
      return this.analyser
    }

    this.detach()
    try {
      const analyser = ctx.createAnalyser()
      analyser.fftSize = ANALYSIS_FFT_SIZE
      analyser.smoothingTimeConstant = 0.65
      // Fan-out: gain already feeds panner/destination; second connect is free.
      gain.connect(analyser)
      this.analyser = analyser
      this.connectedGain = gain
      this.audioRef = audio
      this.freqData = new Uint8Array(analyser.frequencyBinCount)
      return analyser
    } catch {
      this.detach()
      return null
    }
  }

  getAnalyser(): AnalyserNode | null {
    return this.analyser
  }

  getFreqData(): Uint8Array | null {
    return this.freqData
  }

  detach(): void {
    if (this.connectedGain && this.analyser) {
      try {
        this.connectedGain.disconnect(this.analyser)
      } catch {
        // already disconnected
      }
    }
    this.analyser = null
    this.connectedGain = null
    this.freqData = null
    this.audioRef = null
  }

  dispose(): void {
    this.detach()
  }
}
