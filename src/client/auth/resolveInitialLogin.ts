import type { LoginResult } from '../../auth/AuthClient'
import { resumeStoredLogin } from '../../auth/AuthClient'

/**
 * Non-blocking session bootstrap — resume stored wallet or guest.
 * Explorer / landing / 3D share this; no full-screen splash gate.
 */
export function resolveInitialLogin(): LoginResult {
  return resumeStoredLogin() ?? { kind: 'guest' }
}