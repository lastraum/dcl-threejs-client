/**
 * Explorer community group chat wire (comms-message-sfu).
 *
 * Client → SFU: publishData(dest=[message-router-*], topic=`community:{id}`, RFC4 Chat)
 * SFU validates membership, fans out to members with same topic.
 *
 * @see https://github.com/decentraland/comms-message-sfu
 */

/** LiveKit data topic prefix used by Unity Explorer + message SFU. */
export const COMMUNITY_CHAT_TOPIC_PREFIX = 'community:'

export function communityChatTopic(communityId: string): string {
  return `${COMMUNITY_CHAT_TOPIC_PREFIX}${communityId.trim().toLowerCase()}`
}

export function parseCommunityChatTopic(topic: string | undefined | null): string | null {
  const t = topic?.trim() ?? ''
  if (!t.toLowerCase().startsWith(COMMUNITY_CHAT_TOPIC_PREFIX)) return null
  // SFU uses topic.split(':')[1] — UUID has no extra colons.
  const id = t.slice(COMMUNITY_CHAT_TOPIC_PREFIX.length).trim().toLowerCase()
  return id || null
}

/**
 * LiveKit identities for the message router SFU (production default prefix).
 * Prefer live remote participants that match; fall back to replica-0.
 */
export const MESSAGE_ROUTER_IDENTITY_PREFIXES = ['message-router', 'comms-message-sfu'] as const

export function isMessageRouterIdentity(identity: string): boolean {
  const id = identity.trim().toLowerCase()
  return MESSAGE_ROUTER_IDENTITY_PREFIXES.some(
    (p) => id === p || id.startsWith(`${p}-`) || id.startsWith(`${p}_`)
  )
}

/**
 * Fake sender when message-router omitted `forwardedFrom`.
 * Must not be treated as a wallet — `getPeerDisplay('community')` used to
 * middle-ellipsis it to `commun…nity`.
 */
export const COMMUNITY_CHAT_ROUTER_SENDER = 'community'

export function isCommunityChatRouterSender(address: string | undefined | null): boolean {
  return (address?.trim().toLowerCase() ?? '') === COMMUNITY_CHAT_ROUTER_SENDER
}

/** Fallback when SFU not yet visible in remoteParticipants. */
export const MESSAGE_ROUTER_FALLBACK_IDENTITIES = ['message-router-0', 'message-router-1'] as const
