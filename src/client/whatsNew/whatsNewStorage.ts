import { APP_VERSION } from '../appVersion'

/**
 * localStorage key for last-acked client semver (package.json).
 * Flip `WHATS_NEW_PERSIST_ACK` to true when toast testing is done.
 */
export const WHATS_NEW_SEEN_KEY = 'threejs-client:lastSeenVersion'

/**
 * When false (dev/testing): never write localStorage, always treat as "unseen"
 * so the toast reappears every load. When true: dismiss writes lastSeenVersion.
 */
export const WHATS_NEW_PERSIST_ACK = true

export function readLastSeenVersion(): string | null {
  try {
    return localStorage.getItem(WHATS_NEW_SEEN_KEY)
  } catch {
    return null
  }
}

/** Persist ack — no-op while WHATS_NEW_PERSIST_ACK is false (keeps re-testing easy). */
export function markWhatsNewSeen(version: string = APP_VERSION): void {
  if (!WHATS_NEW_PERSIST_ACK) {
    console.info(
      `[whats-new] skip localStorage write (PERSIST_ACK=false) — would set ${WHATS_NEW_SEEN_KEY}=${version}`
    )
    return
  }
  try {
    localStorage.setItem(WHATS_NEW_SEEN_KEY, version)
  } catch {
    /* private mode */
  }
}

/**
 * Whether to show the toast for this build.
 * Testing: always true (unless ?whatsNew=0).
 * Production (PERSIST_ACK): true when stored version !== APP_VERSION.
 */
export function shouldShowWhatsNew(): boolean {
  if (typeof window === 'undefined') return false
  const params = new URLSearchParams(window.location.search)
  if (params.get('whatsNew') === '0') return false
  if (params.get('whatsNew') === '1') return true

  if (!WHATS_NEW_PERSIST_ACK) return true

  const last = readLastSeenVersion()
  if (last === null) return true
  return last !== APP_VERSION
}
