import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import { SceneAccessDeniedError } from './SceneAccessDeniedError'

type SceneBanDebugListener = () => void

function readUrlBanConfig(): { immediate: boolean; delayMs: number } | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (!params.has('sceneban')) return null
  const raw = params.get('sceneban')?.trim().toLowerCase()
  if (!raw || raw === '1' || raw === 'true' || raw === 'now') {
    return { immediate: true, delayMs: 0 }
  }
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds > 0) {
    return { immediate: false, delayMs: Math.round(seconds * 1000) }
  }
  return { immediate: true, delayMs: 0 }
}

/** Dev-only simulated scene ban — `?sceneban`, `?sceneban=15`, or Debug → Simulate scene ban. */
class SceneBanDebugStore {
  private forced = false
  private delayArmedAt = 0
  private delayMs = 0
  private readonly listeners = new Set<SceneBanDebugListener>()

  constructor() {
    const url = readUrlBanConfig()
    if (!url) return
    if (url.immediate) {
      this.forced = true
      clientDebugLog.log('client', 'Scene ban sim ACTIVE (?sceneban) — access checks will fail', {
        level: 'warn'
      })
      return
    }
    this.delayArmedAt = performance.now()
    this.delayMs = url.delayMs
    const sec = Math.round(url.delayMs / 1000)
    clientDebugLog.log(
      'client',
      `Scene ban sim armed — fires in ${sec}s (?sceneban=${sec})`,
      { level: 'warn' }
    )
  }

  isSimulatingBan(): boolean {
    if (this.forced) return true
    if (this.delayArmedAt > 0 && this.delayMs > 0) {
      return performance.now() - this.delayArmedAt >= this.delayMs
    }
    return false
  }

  simulatedBanError(sceneTitle?: string): SceneAccessDeniedError {
    return new SceneAccessDeniedError({
      source: 'gatekeeper_ban',
      sceneTitle,
      customMessage: 'Simulated scene ban (dev — clear ?sceneban or use Debug panel).'
    })
  }

  /** Debug panel — ban immediately (also notifies AppController). */
  triggerNow(): void {
    if (this.forced && this.delayArmedAt === 0 && this.delayMs === 0) {
      this.notify()
      return
    }
    this.forced = true
    this.delayArmedAt = 0
    this.delayMs = 0
    clientDebugLog.log('client', 'Scene ban sim triggered from Debug panel', { level: 'warn' })
    this.notify()
  }

  clear(): void {
    this.forced = false
    this.delayArmedAt = 0
    this.delayMs = 0
  }

  onTrigger(listener: SceneBanDebugListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of this.listeners) listener()
  }
}

export const sceneBanDebug = new SceneBanDebugStore()

export function simulatedSceneAccessDenied(sceneTitle?: string): SceneAccessDeniedError | null {
  if (!sceneBanDebug.isSimulatingBan()) return null
  return sceneBanDebug.simulatedBanError(sceneTitle)
}