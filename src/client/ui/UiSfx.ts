import { mediaElementGain } from '../../rendering/SoundSettings'

let audioCtx: AudioContext | null = null

/** Short HUD click — respects UI SFX + master sliders. */
export function playUiClick(): void {
  const gain = mediaElementGain('ui', 1)
  if (gain <= 0.001) return
  try {
    audioCtx ??= new AudioContext()
    if (audioCtx.state === 'suspended') void audioCtx.resume()
    const osc = audioCtx.createOscillator()
    const amp = audioCtx.createGain()
    osc.type = 'sine'
    osc.frequency.value = 720
    amp.gain.value = gain * 0.06
    osc.connect(amp)
    amp.connect(audioCtx.destination)
    const t0 = audioCtx.currentTime
    osc.start(t0)
    amp.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.04)
    osc.stop(t0 + 0.045)
  } catch {
    /* autoplay policy */
  }
}