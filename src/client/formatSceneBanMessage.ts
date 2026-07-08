import type { SceneLoadErrorMessage } from './formatSceneLoadError'
import { SceneAccessDeniedError } from '../network/sceneAccess/SceneAccessDeniedError'

function cleanGatekeeperCopy(raw: string | undefined): string | null {
  if (!raw?.trim()) return null
  const trimmed = raw.trim()
  if (/^gatekeeper_/i.test(trimmed)) return null
  return trimmed
}

/** User-facing copy when a wallet is blocked from entering a scene. */
export function formatSceneBanMessage(err: SceneAccessDeniedError): SceneLoadErrorMessage {
  const place = err.sceneTitle?.trim() || 'this place'
  const moderatorNote =
    cleanGatekeeperCopy(err.customMessage) ?? cleanGatekeeperCopy(err.gatekeeperError)

  if (err.source === 'metadata_blacklist') {
    return {
      title: "You can't enter this place",
      detail:
        moderatorNote ??
        `Your wallet is blocked from entering ${place}. The scene owner listed this address in the scene policy.`
    }
  }

  if (err.source === 'gatekeeper_blacklist') {
    return {
      title: "You can't enter this place",
      detail:
        moderatorNote ??
        `Your wallet is blocked from entering ${place}. This scene does not allow your address.`
    }
  }

  return {
    title: "You're banned from this place",
    detail:
      moderatorNote ??
      `Your wallet is banned from ${place}. Contact the scene owner if you think this is a mistake.`
  }
}