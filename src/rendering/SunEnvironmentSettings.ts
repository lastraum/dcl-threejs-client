import * as THREE from 'three'

/** Bump when defaults change so old chalk-wash prefs do not stick forever. */
const STORAGE_KEY = 'dcl-sun-environment-settings-v4'

export type SunEnvironmentSettingsState = {
  /** Directional sun + day hemi scene lighting (0–100) */
  sceneSunLight: number
  /** ACES exposure multiplier during day (0–100) */
  exposure: number
  /** Directional moon + night hemi scene lighting (0–100) */
  sceneMoonLight: number
  /** ACES exposure multiplier during night (0–100) */
  moonExposure: number
}

export const SUN_SLIDER_MIN = 0
export const SUN_SLIDER_MAX = 100

/**
 * Skydome sun disc (visual only — independent of scene directional intensity).
 * Cutoff closer to 1 = smaller disc. Glow adds soft halo; keep modest so the disc
 * is a small warm dot, not a screen-filling white circle.
 */
export const FIXED_SUN_DISC_CUTOFF = 0.99855
export const FIXED_SUN_DISC_CORE_GAIN = 0.55
export const FIXED_SUN_DISC_GLOW_GAIN = 0.28

const DEFAULTS: SunEnvironmentSettingsState = {
  /**
   * Scene mesh lighting (Reset lighting). Explorer outdoor key is brighter than our
   * washout-era 44 default (users needed ~100% to match). ~82 ≈ strong mid-morning
   * without maxing the slider; 100 still has headroom for dark rooms.
   */
  sceneSunLight: 82,
  /**
   * Day ACES multiplier. Slightly under mid so blue sky stays saturated while meshes
   * read closer to Explorer (paired with higher sceneSunLight).
   */
  exposure: 56,
  /** Moon light slider default — slightly under mid so 00:00 stays dark. */
  sceneMoonLight: 48,
  /**
   * Night ACES multiplier default. Was 62 (~1.4×) which lifted midnight to dusk.
   * ~48 ≈ neutral-low; slider still goes to 100 for board-readable night.
   */
  moonExposure: 48
}

type Listener = (state: SunEnvironmentSettingsState) => void

function clampSlider(value: number): number {
  return Math.round(THREE.MathUtils.clamp(value, SUN_SLIDER_MIN, SUN_SLIDER_MAX))
}

/**
 * Multiplier on SUN_BRIGHTNESS + directional curve.
 * Floor/ceiling raised so mid-morning (TOD 10:00, raw anim ~1.7) reads Explorer-bright
 * around default slider 82 without requiring 100%.
 */
export function sceneSunLightMultiplier(sceneSunLight: number): number {
  const t = clampSlider(sceneSunLight) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.42, 1.58, t)
}

/** Multiplier on MOON_BRIGHTNESS + night hemi. */
export function sceneMoonLightMultiplier(sceneMoonLight: number): number {
  const t = clampSlider(sceneMoonLight) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.35, 1.45, t)
}

/** Multiplier on tier tone-mapping exposure during day. */
export function sunExposureMultiplier(exposure: number): number {
  const t = clampSlider(exposure) / SUN_SLIDER_MAX
  // Ceiling modest so sky blue + emissives don't chalk when sun key is raised.
  return THREE.MathUtils.lerp(0.72, 1.1, t)
}

/** Multiplier on tier tone-mapping exposure during night (~1.32 at 50%). */
export function moonExposureMultiplier(moonExposure: number): number {
  const t = clampSlider(moonExposure) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.9, 1.75, t)
}

class SunEnvironmentSettingsStore {
  private state: SunEnvironmentSettingsState
  private readonly listeners = new Set<Listener>()

  constructor() {
    this.state = { ...DEFAULTS }
    this.load()
  }

  get(): SunEnvironmentSettingsState {
    return { ...this.state }
  }

  set(partial: Partial<SunEnvironmentSettingsState>): void {
    const next: SunEnvironmentSettingsState = { ...this.state }
    let changed = false

    if (partial.sceneSunLight !== undefined) {
      const v = clampSlider(partial.sceneSunLight)
      if (v !== next.sceneSunLight) {
        next.sceneSunLight = v
        changed = true
      }
    }
    if (partial.exposure !== undefined) {
      const v = clampSlider(partial.exposure)
      if (v !== next.exposure) {
        next.exposure = v
        changed = true
      }
    }
    if (partial.sceneMoonLight !== undefined) {
      const v = clampSlider(partial.sceneMoonLight)
      if (v !== next.sceneMoonLight) {
        next.sceneMoonLight = v
        changed = true
      }
    }
    if (partial.moonExposure !== undefined) {
      const v = clampSlider(partial.moonExposure)
      if (v !== next.moonExposure) {
        next.moonExposure = v
        changed = true
      }
    }

    if (!changed) return
    this.state = next
    this.persist()
    this.notify()
  }

  reset(): void {
    this.state = { ...DEFAULTS }
    this.persist()
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.get())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    const snapshot = this.get()
    for (const listener of this.listeners) listener(snapshot)
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch {
      /* quota or private mode */
    }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<SunEnvironmentSettingsState>
      this.state = {
        sceneSunLight: clampSlider(parsed.sceneSunLight ?? DEFAULTS.sceneSunLight),
        exposure: clampSlider(parsed.exposure ?? DEFAULTS.exposure),
        sceneMoonLight: clampSlider(parsed.sceneMoonLight ?? DEFAULTS.sceneMoonLight),
        moonExposure: clampSlider(parsed.moonExposure ?? DEFAULTS.moonExposure)
      }
    } catch {
      /* corrupt data */
    }
  }
}

export const sunEnvironmentSettings = new SunEnvironmentSettingsStore()

/** True when state matches factory defaults (Reset lighting). */
export function isDefaultSunEnvironmentSettings(state: SunEnvironmentSettingsState): boolean {
  return (
    state.sceneSunLight === DEFAULTS.sceneSunLight &&
    state.exposure === DEFAULTS.exposure &&
    state.sceneMoonLight === DEFAULTS.sceneMoonLight &&
    state.moonExposure === DEFAULTS.moonExposure
  )
}