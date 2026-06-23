export type PlatformMotionDebugOptions = {
  /** Log platform transfer Δ, grounding, and near-player entity motion each frame (throttled). */
  enabled: boolean
}

type Listener = (options: PlatformMotionDebugOptions) => void

function readUrlDefault(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  return params.has('platformdebug') || params.has('carrierdebug') || params.has('platform')
}

const DEFAULT_OPTIONS: PlatformMotionDebugOptions = {
  enabled: readUrlDefault()
}

/** Moving-platform / velocity-transfer diagnostics — Help panel + `?platformdebug`. */
class PlatformMotionDebugStore {
  private options: PlatformMotionDebugOptions = { ...DEFAULT_OPTIONS }
  private readonly listeners = new Set<Listener>()

  getOptions(): PlatformMotionDebugOptions {
    return { ...this.options }
  }

  setOptions(partial: Partial<PlatformMotionDebugOptions>): void {
    const next = { ...this.options, ...partial }
    if (next.enabled === this.options.enabled) return
    this.options = next
    this.notify()
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getOptions())
    return () => {
      this.listeners.delete(listener)
    }
  }

  isEnabled(): boolean {
    return this.options.enabled
  }

  private notify(): void {
    const snapshot = this.getOptions()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const platformMotionDebug = new PlatformMotionDebugStore()