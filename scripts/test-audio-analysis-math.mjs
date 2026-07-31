/**
 * Smoke-check AudioAnalysis sample math (no WebAudio).
 * Run: npx tsx scripts/test-audio-analysis-math.mjs
 */
import {
  bandBinRanges,
  sampleAnalyser,
  quantizeAnalysis,
  samplesEqual,
  AUDIO_ANALYSIS_MODE_RAW,
  AUDIO_ANALYSIS_MODE_LOGARITHMIC,
  DEFAULT_AMPLITUDE_GAIN,
  DEFAULT_BANDS_GAIN
} from '../src/media/audioAnalysisMath.ts'

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const ranges = bandBinRanges(128)
assert(ranges.length === 8, '8 bands')
assert(ranges[0].start >= 1, 'skip DC')
assert(ranges[7].end === 128, 'last band covers end')

// Fake analyser with rising spectrum (bass quiet, treble loud).
const freq = new Uint8Array(128)
for (let i = 0; i < 128; i++) freq[i] = Math.min(255, i * 2)

const fakeAnalyser = {
  getByteFrequencyData(out) {
    out.set(freq)
  }
}

const raw = sampleAnalyser(fakeAnalyser, new Uint8Array(128), AUDIO_ANALYSIS_MODE_RAW)
assert(raw.amplitude > 0 && raw.amplitude <= 1, 'raw amp in range')
assert(raw.bands[7] >= raw.bands[0], 'high band >= low for rising spectrum')

const log = sampleAnalyser(
  fakeAnalyser,
  new Uint8Array(128),
  AUDIO_ANALYSIS_MODE_LOGARITHMIC,
  DEFAULT_AMPLITUDE_GAIN,
  DEFAULT_BANDS_GAIN
)
assert(log.amplitude > 0, 'log amp')
assert(log.bands.every((b) => b >= 0 && b <= 1), 'log bands clamped')
// Default bandsGain 0.05 keeps log bands smaller than raw peaks * gain-ish
assert(log.bands[7] < 1 || log.amplitude <= 1, 'clamped')

assert(quantizeAnalysis(1.5) === 1, 'quantize clamp')
assert(quantizeAnalysis(0.1234) === 0.123, 'quantize 3dp')
assert(samplesEqual(raw, raw), 'equal self')
assert(!samplesEqual(raw, log), 'raw != log')

console.log('✅ AudioAnalysis math smoke passed', {
  rawAmp: raw.amplitude,
  logAmp: log.amplitude,
  rawBands: raw.bands.map((b) => b.toFixed(3)).join(','),
  logBands: log.bands.map((b) => b.toFixed(3)).join(',')
})
