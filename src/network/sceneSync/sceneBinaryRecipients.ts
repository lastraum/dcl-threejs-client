import { AUTHORITATIVE_SERVER_SENDER } from './sceneBinaryWire'

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase()
}

export type SceneBinaryRecipientOptions = {
  localAddress: string | null
  /** Explorer #9026 — always route scene-pipe sends to auth server when it is in the room. */
  includeAuthServerIfPresent: boolean
  hasRemoteParticipant: (identity: string) => boolean
}

/**
 * Resolve LiveKit `destinationIdentities` for sync-systems `sendBinary` peerData.
 * Returns `undefined` for room broadcast (empty address list).
 */
export function resolveSceneBinaryDestinations(
  addresses: string[],
  options: SceneBinaryRecipientOptions
): string[] | undefined {
  if (addresses.length === 0) return undefined

  const local = options.localAddress ? normalizeIdentity(options.localAddress) : null
  const recipients = new Set<string>()

  for (const raw of addresses) {
    const key = normalizeIdentity(raw)
    if (!key || key === local) continue
    recipients.add(key)
  }

  if (
    options.includeAuthServerIfPresent &&
    options.hasRemoteParticipant(AUTHORITATIVE_SERVER_SENDER)
  ) {
    recipients.add(AUTHORITATIVE_SERVER_SENDER)
  }

  if (recipients.size === 0) return undefined
  return [...recipients]
}