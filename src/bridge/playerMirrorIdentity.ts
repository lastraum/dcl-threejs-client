import { BODY_SHAPE_URN } from '../avatar/constants'
import { normalizeProfileWearables } from '../avatar/peerApi'
import type { AvatarProfile } from '../avatar/types'

const GUEST_ID_KEY = 'dcl-client-guest-id'

type PbColor3 = { r: number; g: number; b: number }

export type PlayerMirrorIdentity = {
  address: string
  isGuest: boolean
  displayName: string
  bodyShapeUrn: string
  skinColor: PbColor3
  hairColor: PbColor3
  eyesColor: PbColor3
  wearableUrns: string[]
  emoteUrns: string[]
}

function hexToColor3(hex: string): PbColor3 {
  const normalized = hex.replace(/^#/, '').padEnd(6, '0').slice(0, 6)
  return {
    r: parseInt(normalized.slice(0, 2), 16) / 255,
    g: parseInt(normalized.slice(2, 4), 16) / 255,
    b: parseInt(normalized.slice(4, 6), 16) / 255
  }
}

export function getOrCreateGuestAddress(): string {
  if (typeof sessionStorage !== 'undefined') {
    const stored = sessionStorage.getItem(GUEST_ID_KEY)?.trim()
    if (stored) return stored
    const id = crypto.randomUUID()
    sessionStorage.setItem(GUEST_ID_KEY, id)
    return id
  }
  return crypto.randomUUID()
}

function defaultGuestProfile(address: string): AvatarProfile {
  const { bodyShape, wearables } = normalizeProfileWearables(undefined, [])
  return {
    bodyShape,
    skin: 'cc9b76',
    hair: '3a3a3a',
    eyes: '3a3a3a',
    wearables,
    forceRender: [],
    emotes: [],
    fromWallet: false,
    address,
    displayName: 'Guest'
  }
}

export function buildPlayerMirrorIdentity(opts: {
  address?: string
  profile?: AvatarProfile | null
  displayName?: string
}): PlayerMirrorIdentity {
  const address = opts.address?.toLowerCase()
  if (!address) {
    const guestAddress = getOrCreateGuestAddress()
    const profile = opts.profile ?? defaultGuestProfile(guestAddress)
    return profileToMirrorIdentity(guestAddress, true, profile.displayName ?? 'Guest', profile)
  }

  const profile = opts.profile ?? defaultGuestProfile(address)
  return profileToMirrorIdentity(
    address,
    false,
    opts.displayName?.trim() || profile.displayName?.trim() || address,
    profile
  )
}

function profileToMirrorIdentity(
  address: string,
  isGuest: boolean,
  displayName: string,
  profile: AvatarProfile
): PlayerMirrorIdentity {
  const { wearables } = normalizeProfileWearables(BODY_SHAPE_URN[profile.bodyShape], profile.wearables)
  return {
    address,
    isGuest,
    displayName,
    bodyShapeUrn: BODY_SHAPE_URN[profile.bodyShape],
    skinColor: hexToColor3(profile.skin),
    hairColor: hexToColor3(profile.hair),
    eyesColor: hexToColor3(profile.eyes),
    wearableUrns: wearables,
    emoteUrns: []
  }
}
