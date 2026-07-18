import { parseRouteTarget, type RouteTarget } from '../dcl/content/route'
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
 * Map realm string → playable route (coords or world).
 * Bare names become `name.dcl.eth` via parseRouteTarget.
 */
export function parseChangeRealmTarget(realm: string): Extract<RouteTarget, { kind: 'coords' } | { kind: 'world' }> | null {
  const raw = realm.trim()
  if (!raw) return null
  // Drop realm URL prefixes if scenes pass full adapter strings.
  const cleaned = raw
    .replace(/^https?:\/\//i, '')
    .replace(/\/+$/, '')
    .split('/')
    .pop()
    ?.trim() || raw
  const target = parseRouteTarget(cleaned)
  if (target.kind === 'coords' || target.kind === 'world') return target
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
