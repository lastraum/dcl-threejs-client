/**
 * AudioAnalysis (1212) sample math — Explorer-best-effort.
 * Official docs: MODE_RAW unprocessed; MODE_LOGARITHMIC applies amplitudeGain (default 5)
 * and bandsGain (default 0.05). Exact Unity FFT grouping is unpublished — log band
 * partitions + gain multipliers match creator docs; calibrate vs 88,-10-audio-visualization.
 */

export const AUDIO_ANALYSIS_MODE_RAW = 0
export const AUDIO_ANALYSIS_MODE_LOGARITHMIC = 1

/** Docs defaults when scene omits optional gains (log mode only). */
export const DEFAULT_AMPLITUDE_GAIN = 5
export const DEFAULT_BANDS_GAIN = 0.05

/** FFT size for AnalyserNode — frequencyBinCount = 128. */
export const ANALYSIS_FFT_SIZE = 256

const BAND_COUNT = 8
const QUANTIZE = 1000 // 3 decimal places → dirty-only LWW

export type AnalysisSample = {
  amplitude: number
  bands: [number, number, number, number, number, number, number, number]
}

export function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0
  return v < 0 ? 0 : v > 1 ? 1 : v
}

export function quantizeAnalysis(v: number): number {
  return Math.round(clamp01(v) * QUANTIZE) / QUANTIZE
}

/**
 * Partition frequency bins into 8 logarithmic groups (skip DC bin 0).
 * Low bands cover fewer bins (bass); high bands cover more (treble).
 */
export function bandBinRanges(binCount: number): Array<{ start: number; end: number }> {
  const usable = Math.max(binCount - 1, 1)
  const ranges: Array<{ start: number; end: number }> = []
  let start = 1
  for (let k = 0; k < BAND_COUNT; k++) {
    const t0 = k / BAND_COUNT
    const t1 = (k + 1) / BAND_COUNT
    // Exponential edge positions over usable bins.
    const e0 = Math.floor((Math.pow(2, t0) - 1) / (2 - 1) * usable)
    const e1 = Math.floor((Math.pow(2, t1) - 1) / (2 - 1) * usable)
    const s = Math.min(binCount - 1, Math.max(1, start, e0 + 1))
    const e = Math.min(binCount, Math.max(s + 1, e1 + 1))
    ranges.push({ start: s, end: e })
    start = e
  }
  // Ensure last band reaches end of spectrum.
  if (ranges.length) ranges[ranges.length - 1].end = binCount
  return ranges
}

/** Mean of byte frequency data in [start, end) → 0..1. */
function meanRange(data: Uint8Array, start: number, end: number): number {
  const a = Math.max(0, start)
  const b = Math.min(data.length, end)
  if (b <= a) return 0
  let sum = 0
  for (let i = a; i < b; i++) sum += data[i]
  return sum / ((b - a) * 255)
}

/**
 * Sample AnalyserNode → amplitude + 8 bands.
 * @param mode PBAudioAnalysisMode
 * @param amplitudeGain log-mode amp multiplier (default 5)
 * @param bandsGain log-mode band multiplier (default 0.05)
 */
export function sampleAnalyser(
  analyser: AnalyserNode,
  freqData: Uint8Array,
  mode: number,
  amplitudeGain?: number,
  bandsGain?: number
): AnalysisSample {
  analyser.getByteFrequencyData(freqData as Uint8Array<ArrayBuffer>)
  const binCount = freqData.length
  const ranges = bandBinRanges(binCount)

  const rawBands: number[] = []
  let rawSum = 0
  for (let k = 0; k < BAND_COUNT; k++) {
    const r = ranges[k]!
    const m = meanRange(freqData, r.start, r.end)
    rawBands.push(m)
    rawSum += m
  }
  const rawAmp = rawSum / BAND_COUNT

  if (mode === AUDIO_ANALYSIS_MODE_RAW) {
    return {
      amplitude: quantizeAnalysis(rawAmp),
      bands: rawBands.map(quantizeAnalysis) as AnalysisSample['bands']
    }
  }

  // LOGARITHMIC (default): perceptual-ish log curve, then docs gains.
  // bandsGain default 0.05 is a small multiplier on 0..1 bins — matches docs
  // ("multiplier applied to all 8 bands"); visualizers typically scale mesh height themselves.
  const ampG = amplitudeGain ?? DEFAULT_AMPLITUDE_GAIN
  const bandG = bandsGain ?? DEFAULT_BANDS_GAIN
  const logCurve = (v: number) => Math.log1p(v * 24) / Math.log1p(24)

  return {
    amplitude: quantizeAnalysis(logCurve(rawAmp) * ampG),
    bands: rawBands.map((b) => quantizeAnalysis(logCurve(b) * bandG)) as AnalysisSample['bands']
  }
}

export function samplesEqual(a: AnalysisSample, b: AnalysisSample): boolean {
  if (a.amplitude !== b.amplitude) return false
  for (let i = 0; i < BAND_COUNT; i++) {
    if (a.bands[i] !== b.bands[i]) return false
  }
  return true
}
