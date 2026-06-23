import type { LandscapeEnvironmentKind } from '../dcl/landscape/EnvironmentCatalog'

export type EnvironmentDebugState = {
  /** Resolved non-`none` biome on the current scene (null when off or not loaded). */
  loadedKind: LandscapeEnvironmentKind | null
  /** Runtime hide — landscape, ocean, and genesis sky dome. */
  disabled: boolean
}

type Listener = (state: EnvironmentDebugState) => void

/** Help panel toggle for hiding a loaded client environment at runtime. */
class EnvironmentDebugStore {
  private loadedKind: LandscapeEnvironmentKind | null = null
  private disabled = false
  private readonly listeners = new Set<Listener>()

  getState(): EnvironmentDebugState {
    return { loadedKind: this.loadedKind, disabled: this.disabled }
  }

  hasLoadedEnvironment(): boolean {
    return this.loadedKind !== null
  }

  isDisabled(): boolean {
    return this.disabled
  }

  /** Called when a scene finishes resolving its environment. Resets the runtime toggle. */
  setSceneEnvironment(kind: LandscapeEnvironmentKind): void {
    const loaded = kind === 'none' ? null : kind
    if (this.loadedKind === loaded && !this.disabled) return
    this.loadedKind = loaded
    this.disabled = false
    this.notify()
  }

  setDisabled(disabled: boolean): void {
    if (!this.loadedKind || this.disabled === disabled) return
    this.disabled = disabled
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getState())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    const snapshot = this.getState()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const environmentDebug = new EnvironmentDebugStore()
