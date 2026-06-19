export type FftOceanSettings = {
  enabled: boolean
  meshResolution: number
  fftResolution: number
}

function parseIntQuery(value: string | null, fallback: number): number {
  if (!value) return fallback
  const n = Number.parseInt(value, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function parseBoolQueryOptional(value: string | null): boolean | null {
  if (!value) return null
  const v = value.trim().toLowerCase()
  if (v === '0' || v === 'false' || v === 'no') return false
  if (v === '1' || v === 'true' || v === 'yes') return true
  return null
}

function fftOceanParam(params: URLSearchParams): string | null {
  return params.get('fftOcean') ?? params.get('fftocean') ?? params.get('fft')
}

/** FFTOCEAN GPGPU ocean by default; `?fftOcean=0` falls back to Water.js. */
export function readFftOceanOverride(): FftOceanSettings {
  if (typeof window === 'undefined') {
    return { enabled: true, meshResolution: 256, fftResolution: 256 }
  }

  const params = new URLSearchParams(window.location.search)
  const mobile = window.innerWidth <= 768

  return {
    enabled: parseBoolQueryOptional(fftOceanParam(params)) ?? true,
    meshResolution: parseIntQuery(params.get('oceanResolution'), 256),
    fftResolution: parseIntQuery(params.get('fftResolution'), mobile ? 128 : 256)
  }
}

/** Keys that must trigger a full scene reload when changed (path unchanged). */
export function readSceneDevQueryKey(): string {
  if (typeof window === 'undefined') return ''
  const params = new URLSearchParams(window.location.search)
  return [
    params.get('environment') ?? params.get('env') ?? '',
    params.get('disableSun') ?? '',
    params.get('disableMoon') ?? '',
    fftOceanParam(params) ?? '',
    params.get('fftResolution') ?? '',
    params.get('oceanResolution') ?? ''
  ].join('|')
}