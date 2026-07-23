/**
 * Physics / walk-bound diagnostics.
 * Console lines respect Help → Debug “Browser console logs” (or `?physdebug`).
 *
 * `?physdebug` — extra detail (more collider samples, unthrottled freeze hold notes).
 */
import { clientDebugLog } from '../client/debug/ClientDebugLog'

function params(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search)
}

export function isPhysicsDiagVerbose(): boolean {
  const p = params()
  if (!p) return false
  return p.has('physdebug') || p.has('physicsdebug') || p.has('colliderdebug')
}

const lastAt = new Map<string, number>()

/** Throttled `[phys]` line — console only when mirror is on or `?physdebug`. */
export function physLog(key: string, message: string, throttleMs = 800): void {
  const now = performance.now()
  const prev = lastAt.get(key) ?? 0
  if (now - prev < throttleMs && !isPhysicsDiagVerbose()) return
  lastAt.set(key, now)
  if (isPhysicsDiagVerbose()) {
    console.info(`[phys] ${message}`)
    return
  }
  clientDebugLog.consoleOnly('info', `[phys] ${message}`)
}

export function formatWalkBounds(walk: {
  mode: string
  bounds?: { minX: number; maxX: number; minZ: number; maxZ: number }
  circle?: { centerX: number; centerZ: number; radiusM: number }
}): string {
  if (walk.mode === 'circle' && walk.circle) {
    const c = walk.circle
    return `circle c=(${c.centerX.toFixed(1)},${c.centerZ.toFixed(1)}) r=${c.radiusM.toFixed(1)}m`
  }
  if (walk.mode === 'rect' && walk.bounds) {
    const b = walk.bounds
    return `rect x=[${b.minX.toFixed(1)}..${b.maxX.toFixed(1)}] z=[${b.minZ.toFixed(1)}..${b.maxZ.toFixed(1)}]`
  }
  return walk.mode
}
