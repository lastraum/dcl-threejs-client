/**
 * Portable experience / smart wearable `requiredPermissions` from scene.json.
 * Labels match Explorer's activate-PEX consent modal.
 *
 * @see https://docs.decentraland.org/creator/scenes-sdk7/kinds-of-projects/scene-metadata
 */

export type PePermissionCode =
  | 'ALLOW_TO_MOVE_PLAYER_INSIDE_SCENE'
  | 'ALLOW_TO_TRIGGER_AVATAR_EMOTE'
  | 'ALLOW_MEDIA_HOSTNAMES'
  | 'USE_WEB3_API'
  | 'USE_FETCH'
  | 'USE_WEBSOCKET'
  | 'OPEN_EXTERNAL_LINK'
  | string

/** Explorer-style bullet labels shown in the activate modal. */
const PERMISSION_LABELS: Record<string, string> = {
  USE_WEB3_API: 'Request to interact with your account wallet',
  OPEN_EXTERNAL_LINK: 'Request to open an external link',
  USE_WEBSOCKET: 'Use Web Sockets',
  USE_FETCH: 'Use the Fetch API',
  ALLOW_TO_MOVE_PLAYER_INSIDE_SCENE: 'Move your avatar inside the scene',
  ALLOW_TO_TRIGGER_AVATAR_EMOTE: 'Play emotes on your avatar',
  ALLOW_MEDIA_HOSTNAMES: 'Stream media from external domains'
}

export type PePermissionDisplay = {
  code: string
  label: string
  /** Wallet permission shows an info affordance in Explorer. */
  showInfo?: boolean
}

export function parseRequiredPermissions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const row of raw) {
    if (typeof row !== 'string') continue
    const code = row.trim().toUpperCase()
    if (code && !out.includes(code)) out.push(code)
  }
  return out
}

export function permissionDisplayList(codes: string[]): PePermissionDisplay[] {
  return codes.map((code) => ({
    code,
    label: PERMISSION_LABELS[code] ?? humanizePermissionCode(code),
    showInfo: code === 'USE_WEB3_API'
  }))
}

function humanizePermissionCode(code: string): string {
  return code
    .replace(/^ALLOW_TO_/, '')
    .replace(/^USE_/, '')
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ')
}
