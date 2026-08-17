const STORAGE_KEY = 'dcl-client-settings'

export type ClientSettingsState = {
  fov: number
  /** Percent of base look speed (10–200). 100 = default. */
  mouseSensitivity: number
  /**
   * Genesis-lab ability VFX (ice LINE, etc.). Off by default — warming
   * AbilityManager + first shader compile is opt-in.
   */
  abilityVfxEnabled: boolean
}

const DEFAULTS: ClientSettingsState = {
  fov: 60,
  mouseSensitivity: 100,
  abilityVfxEnabled: false
}

export const FOV_MIN = 40
export const FOV_MAX = 120
export const MOUSE_SENSITIVITY_MIN = 10
export const MOUSE_SENSITIVITY_MAX = 200

type Listener = (state: ClientSettingsState) => void

function clampFov(fov: number): number {
  return Math.round(Math.max(FOV_MIN, Math.min(FOV_MAX, fov)))
}

function clampMouseSensitivity(value: number): number {
  return Math.round(Math.max(MOUSE_SENSITIVITY_MIN, Math.min(MOUSE_SENSITIVITY_MAX, value)))
}

class ClientSettingsStore {
  private state: ClientSettingsState
  private readonly listeners = new Set<Listener>()

  constructor() {
    this.state = { ...DEFAULTS }
    this.load()
  }

  get(): ClientSettingsState {
    return { ...this.state }
  }

  getFov(): number {
    return this.state.fov
  }

  setFov(fov: number): void {
    const clamped = clampFov(fov)
    if (clamped === this.state.fov) return
    this.state = { ...this.state, fov: clamped }
    this.persist()
    this.notify()
  }

  getMouseSensitivity(): number {
    return this.state.mouseSensitivity
  }

  /** Multiplier for pointer look (1.0 = default). */
  getMouseSensitivityScale(): number {
    return this.state.mouseSensitivity / 100
  }

  setMouseSensitivity(value: number): void {
    const clamped = clampMouseSensitivity(value)
    if (clamped === this.state.mouseSensitivity) return
    this.state = { ...this.state, mouseSensitivity: clamped }
    this.persist()
    this.notify()
  }

  getAbilityVfxEnabled(): boolean {
    return this.state.abilityVfxEnabled
  }

  setAbilityVfxEnabled(on: boolean): void {
    if (on === this.state.abilityVfxEnabled) return
    this.state = { ...this.state, abilityVfxEnabled: on }
    this.persist()
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => { this.listeners.delete(listener) }
  }

  private notify(): void {
    const snapshot = this.get()
    for (const listener of this.listeners) listener(snapshot)
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state))
    } catch { /* quota or private mode */ }
  }

  private load(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      if (!raw) return
      const parsed = JSON.parse(raw) as Partial<ClientSettingsState>
      if (typeof parsed.fov === 'number') {
        this.state.fov = clampFov(parsed.fov)
      }
      if (typeof parsed.mouseSensitivity === 'number') {
        this.state.mouseSensitivity = clampMouseSensitivity(parsed.mouseSensitivity)
      }
      if (typeof parsed.abilityVfxEnabled === 'boolean') {
        this.state.abilityVfxEnabled = parsed.abilityVfxEnabled
      }
    } catch { /* corrupt data */ }
  }
}

export const clientSettings = new ClientSettingsStore()
