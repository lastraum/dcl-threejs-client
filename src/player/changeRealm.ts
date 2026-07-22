import { parseTravelTarget, type RouteTarget } from '../dcl/content/route'
import { showHudConfirm } from './hudConfirm'

/**
 * SDK `RestrictedActions.changeRealm` — switch realm / world.
 * Explorer prompts the user; we confirm when `message` is set, then navigate.
 */
export type ChangeRealmRequest = {
  realm: string
  message?: string
}

export type ChangeRealmResponse = {
  success: boolean
}

/**
 * Map realm string → playable route (coords, official world, or custom server URL).
 * Accepts Explorer-style `host/world/Name`, full jump URLs with `?realm=`,
 * and legacy `customServer=&worldName=` (same as chat `/changerealm` / `/goto`).
 */
export function parseChangeRealmTarget(
  realm: string
): Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }> | null {
  const raw = realm.trim()
  if (!raw) return null
  const target = parseTravelTarget(raw)
  if (target && (target.kind === 'coords' || target.kind === 'world')) return target
  return null
}

/** Optional HUD confirm — returns false if user cancels. */
export async function confirmChangeRealm(request: ChangeRealmRequest): Promise<boolean> {
  const msg = request.message?.trim()
  if (!msg) return true
  return showHudConfirm({
    title: 'Travel',
    message: msg,
    confirmLabel: 'Jump',
    cancelLabel: 'Cancel'
  })
}
