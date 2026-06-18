import * as THREE from 'three'

const STORAGE_KEY = 'dcl-sun-environment-settings'

export type SunEnvironmentSettingsState = {
  /** 0 = small disc, 100 = large disc */
  discSize: number
  /** Corona/bloom around the skydome sun (0–100) */
  discGlow: number
  /** Skydome sun disc core intensity (0–100) */
  discBrightness: number
  /** Directional sun + hemi scene lighting (0–100) */
  sceneSunLight: number
  /** ACES exposure multiplier on top of quality tier (0–100) */
  exposure: number
  /** Enable corona/bloom on the skydome sun */
  sunGlowEnabled: boolean
}

export const SUN_DISC_SIZE_MIN = 0
export const SUN_DISC_SIZE_MAX = 100
export const SUN_SLIDER_MIN = 0
export const SUN_SLIDER_MAX = 100

const DEFAULTS: SunEnvironmentSettingsState = {
  discSize: 52,
  discGlow: 42,
  discBrightness: 42,
  sceneSunLight: 56,
  exposure: 80,
  sunGlowEnabled: true
}

type Listener = (state: SunEnvironmentSettingsState) => void

function clampSlider(value: number): number {
  return Math.round(THREE.MathUtils.clamp(value, SUN_SLIDER_MIN, SUN_SLIDER_MAX))
}

/** Skydome sun angular cutoff — higher dot threshold = smaller visible disc. */
export function sunDiscCutoff(size: number): number {
  const t = clampSlider(size) / SUN_DISC_SIZE_MAX
  return THREE.MathUtils.lerp(0.99885, 0.992, t)
}

export function sunDiscCoreGain(brightness: number): number {
  const t = clampSlider(brightness) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.15, 3.2, t)
}

export function sunDiscGlowGain(glow: number, enabled: boolean): number {
  if (!enabled) return 0
  const t = clampSlider(glow) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.0, 1.0, t)
}

/** Multiplier on SUN_BRIGHTNESS + directional curve. */
export function sceneSunLightMultiplier(sceneSunLight: number): number {
  const t = clampSlider(sceneSunLight) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.35, 1.45, t)
}

/** Multiplier on tier tone-mapping exposure. */
export function sunExposureMultiplier(exposure: number): number {
  const t = clampSlider(exposure) / SUN_SLIDER_MAX
  return THREE.MathUtils.lerp(0.72, 1.18, t)
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

    if (partial.discSize !== undefined) {
      const v = clampSlider(partial.discSize)
      if (v !== next.discSize) {
        next.discSize = v
        changed = true
      }
    }
    if (partial.discGlow !== undefined) {
      const v = clampSlider(partial.discGlow)
      if (v !== next.discGlow) {
        next.discGlow = v
        changed = true
      }
    }
    if (partial.discBrightness !== undefined) {
      const v = clampSlider(partial.discBrightness)
      if (v !== next.discBrightness) {
        next.discBrightness = v
        changed = true
      }
    }
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
    if (partial.sunGlowEnabled !== undefined && partial.sunGlowEnabled !== next.sunGlowEnabled) {
      next.sunGlowEnabled = partial.sunGlowEnabled
      changed = true
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
        discSize: clampSlider(parsed.discSize ?? DEFAULTS.discSize),
        discGlow: clampSlider(parsed.discGlow ?? DEFAULTS.discGlow),
        discBrightness: clampSlider(parsed.discBrightness ?? DEFAULTS.discBrightness),
        sceneSunLight: clampSlider(parsed.sceneSunLight ?? DEFAULTS.sceneSunLight),
        exposure: clampSlider(parsed.exposure ?? DEFAULTS.exposure),
        sunGlowEnabled: parsed.sunGlowEnabled ?? DEFAULTS.sunGlowEnabled
      }
    } catch {
      /* corrupt data */
    }
  }
}

export const sunEnvironmentSettings = new SunEnvironmentSettingsStore()