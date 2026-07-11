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
    // Default 128 FFT — 256 costs ~17 GPGPU passes/frame @30Hz and starves play (menus, select).
    return { enabled: true, meshResolution: 256, fftResolution: 128 }
  }

  const params = new URLSearchParams(window.location.search)
  const mobile = window.innerWidth <= 768

  return {
    enabled: parseBoolQueryOptional(fftOceanParam(params)) ?? true,
    meshResolution: parseIntQuery(params.get('oceanResolution'), 256),
    // Desktop default 128 (use `?fftResolution=256` for high quality).
    fftResolution: parseIntQuery(params.get('fftResolution'), mobile ? 64 : 128)
  }
}

/**
 * Disable all client water (FFT + Water.js island/open).
 * `?water=0` / `?noWater=1` / `?disableWater=1`
 */
export function isClientWaterDisabled(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  const water = parseBoolQueryOptional(params.get('water'))
  if (water === false) return true
  if (parseBoolQueryOptional(params.get('noWater')) === true) return true
  if (parseBoolQueryOptional(params.get('disableWater')) === true) return true
  return false
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
    params.get('oceanResolution') ?? '',
    params.get('water') ?? '',
    params.get('noWater') ?? '',
    params.get('disableWater') ?? ''
  ].join('|')
}