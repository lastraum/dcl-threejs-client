const STORAGE_KEY = 'dcl-client-settings'

export type ClientSettingsState = {
  fov: number
}

const DEFAULTS: ClientSettingsState = {
  fov: 60
}

export const FOV_MIN = 40
export const FOV_MAX = 120

type Listener = (state: ClientSettingsState) => void

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
    const clamped = Math.round(Math.max(FOV_MIN, Math.min(FOV_MAX, fov)))
    if (clamped === this.state.fov) return
    this.state = { ...this.state, fov: clamped }
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
      const parsed = JSON.parse(raw)
      if (typeof parsed.fov === 'number') {
        this.state.fov = Math.round(Math.max(FOV_MIN, Math.min(FOV_MAX, parsed.fov)))
      }
    } catch { /* corrupt data */ }
  }
}

export const clientSettings = new ClientSettingsStore()
