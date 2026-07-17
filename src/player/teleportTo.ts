/**
 * SDK `RestrictedActions.teleportTo` — jump to Genesis parcel coordinates.
 * @see ~system/RestrictedActions TeleportToRequest
 */
export type TeleportToRequest = {
  worldCoordinates?: { x: number; y: number }
}

/** SDK returns empty object. */
export type TeleportToResponse = Record<string, never>

export function parseTeleportParcel(
  request: TeleportToRequest
): { x: number; y: number } | null {
  const c = request.worldCoordinates
  if (!c) return null
  const x = Number(c.x)
  const y = Number(c.y)
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null
  return { x: Math.trunc(x), y: Math.trunc(y) }
}
