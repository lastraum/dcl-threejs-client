export type CameraCollisionDebugOptions = {
  /** Third-person PhysX sweep from pivot to camera — on by default. */
  wallOcclusion: boolean
}

type Listener = (options: CameraCollisionDebugOptions) => void

function readUrlDefault(): boolean {
  if (typeof window === 'undefined') return true
  const q = new URLSearchParams(window.location.search)
  if (q.has('nocamerasweep')) return false
  if (q.has('camerasweep')) return true
  return true
}

const DEFAULT_OPTIONS: CameraCollisionDebugOptions = {
  wallOcclusion: readUrlDefault()
}

/** Third-person camera wall occlusion — on by default. `?nocamerasweep` disables. */
class CameraCollisionDebugStore {
  private options: CameraCollisionDebugOptions = { ...DEFAULT_OPTIONS }
  private readonly listeners = new Set<Listener>()

  getOptions(): CameraCollisionDebugOptions {
    return { ...this.options }
  }

  setOptions(partial: Partial<CameraCollisionDebugOptions>): void {
    const next = { ...this.options, ...partial }
    if (next.wallOcclusion === this.options.wallOcclusion) return
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

  isWallOcclusionEnabled(): boolean {
    return this.options.wallOcclusion
  }

  private notify(): void {
    const snapshot = this.getOptions()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const cameraCollisionDebug = new CameraCollisionDebugStore()