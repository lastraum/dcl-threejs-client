import * as THREE from 'three'

const STORAGE_KEY = 'dcl-sun-environment-settings'

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

/** Locked skydome sun — matches former slider 0% (small disc, no corona, dim core). */
export const FIXED_SUN_DISC_CUTOFF = 0.99885
export const FIXED_SUN_DISC_CORE_GAIN = 0.15
export const FIXED_SUN_DISC_GLOW_GAIN = 0

const DEFAULTS: SunEnvironmentSettingsState = {
  sceneSunLight: 56,
  exposure: 80,
  sceneMoonLight: 56,
  moonExposure: 50
}

type Listener = (state: SunEnvironmentSettingsState) => void

function clampSlider(value: number): number {
  return Math.round(THREE.MathUtils.clamp(value, SUN_SLIDER_MIN, SUN_SLIDER_MAX))
}

/** Multiplier on SUN_BRIGHTNESS + directional curve. */
export function sceneSunLightMultiplier(sceneSunLight: number): number {
  const t = clampSlider(sceneSunLight) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.35, 1.45, t)
}

/** Multiplier on MOON_BRIGHTNESS + night hemi. */
export function sceneMoonLightMultiplier(sceneMoonLight: number): number {
  const t = clampSlider(sceneMoonLight) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.35, 1.45, t)
}

/** Multiplier on tier tone-mapping exposure during day. */
export function sunExposureMultiplier(exposure: number): number {
  const t = clampSlider(exposure) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.72, 1.18, t)
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