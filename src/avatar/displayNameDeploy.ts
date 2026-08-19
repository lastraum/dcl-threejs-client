import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { AvatarProfile } from './types'
import {
  deployAvatarProfile,
  type DeployProfileResult,
  type ProfileNamePatch
} from './deployProfile'
import { ensureGuestCatalystProfile } from './guestProfile'
import { fetchProfileLambdaEntryCached } from './peerApi'
import { PEER_URL } from './constants'

/** Explorer unclaimed-name cap (ProfilePopup comment). */
export const DISPLAY_NAME_MAX_LEN = 15

export type DisplayNameChoice =
  | { mode: 'claimed' }
  | { mode: 'custom'; name: string }

export function sanitizeDisplayName(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().slice(0, DISPLAY_NAME_MAX_LEN)
}

/** Null when valid. */
export function validateDisplayName(raw: string): string | null {
  const name = sanitizeDisplayName(raw)
  if (!name) return 'Enter a name'
  if (name.length < 2) return 'Name is too short'
  if (/^0x[a-fA-F0-9]{40}$/.test(name)) return 'Use a display name, not a wallet'
  return null
}

/**
 * Signed Catalyst profile deploy that only changes name fields.
 * Guests: first create if missing, then same entity update as backpack.
 * Wallet with a claimed name: `claimed` keeps hasClaimedName; `custom` sets
 * unclaimedName and leaves `name` as the owned DCL name so they can toggle back.
 */
/** Owned DCL name if the lambda entry still holds one (even after switching to custom). */
export async function resolveClaimedName(address: string, peerUrl?: string): Promise<string | null> {
  const entry = await fetchProfileLambdaEntryCached(address.trim().toLowerCase(), peerUrl)
  const name = entry?.name?.trim() || ''
  const unclaimed = entry?.unclaimedName?.trim() || ''
  if (entry?.hasClaimedName && name) return name
  if (name && unclaimed && name !== unclaimed) return name
  return null
}

export async function deployDisplayName(opts: {
  address: string
  identity: AuthIdentity
  profile: AvatarProfile
  peerUrl?: string
  choice: DisplayNameChoice
}): Promise<DeployProfileResult> {
  const address = opts.address.trim().toLowerCase()
  const peerUrl = (opts.peerUrl ?? PEER_URL).replace(/\/$/, '')

  let custom = ''
  if (opts.choice.mode === 'custom') {
    const err = validateDisplayName(opts.choice.name)
    if (err) throw new Error(err)
    custom = sanitizeDisplayName(opts.choice.name)
  }

  let entry = await fetchProfileLambdaEntryCached(address, peerUrl)
  if (!entry?.avatar) {
    if (opts.choice.mode !== 'custom') {
      throw new Error('No claimed name on this account yet')
    }
    const created = await ensureGuestCatalystProfile({
      address,
      identity: opts.identity,
      displayName: custom,
      peerUrl
    })
    entry = await fetchProfileLambdaEntryCached(address, peerUrl)
    if (created.created && entry) {
      return {
        entityId: '',
        contentUrl: `${peerUrl.replace(/\/$/, '')}/content`,
        wearables: Array.isArray(entry.avatar?.wearables) ? entry.avatar.wearables : [],
        entry
      }
    }
    if (!entry?.avatar) {
      throw new Error('Could not create a Catalyst profile for this name')
    }
  }

  const claimedStored = entry.name?.trim() || ''
  const currentlyClaimed = !!entry.hasClaimedName && claimedStored.length > 0
  const patch: ProfileNamePatch =
    opts.choice.mode === 'claimed'
      ? {
          name: claimedStored || custom,
          unclaimedName: entry.unclaimedName?.trim() || claimedStored,
          hasClaimedName: true
        }
      : {
          // Keep owned DCL name in `name` so claimed mode can restore it.
          name: currentlyClaimed ? claimedStored : custom,
          unclaimedName: custom,
          hasClaimedName: false
        }

  if (opts.choice.mode === 'claimed' && !currentlyClaimed && !claimedStored) {
    throw new Error('No DCL name on this account')
  }

  return deployAvatarProfile({
    address,
    identity: opts.identity,
    profile: opts.profile,
    peerUrl,
    namePatch: patch
  })
}
