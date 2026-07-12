import type { LoginResult } from '../../auth/AuthClient'
import { resumeStoredLogin } from '../../auth/AuthClient'

/**
 * Non-blocking session bootstrap — resume stored wallet, else silent guest for 2D shell.
 * 3D Jump In still requires an explicit Guest / wallet confirm (see AppController).
 */
export function resolveInitialLogin(): LoginResult {
  return resumeStoredLogin() ?? { kind: 'guest' }
}

/** True when a wallet session was restored — ready for Jump In without re-prompt. */
export function hasResumedWalletSession(): boolean {
  return resumeStoredLogin()?.kind === 'wallet'
}