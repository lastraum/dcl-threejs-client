/**
 * Random base-avatar guest profile + first-time Catalyst create deploy.
 */
import { Authenticator } from '@dcl/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { AuthChain } from '@dcl/schemas'
import { EntityType } from '@dcl/schemas'
import { BODY_SHAPE_URN, defaultGuestWearableUrns, PEER_URL } from './constants'
import {
  avatarEntryToCommsEntity,
  clearProfileCaches,
  fetchProfileLambdaEntryCached,
  type CommsProfileEntity,
  type LambdaAvatarEntry
} from './peerApi'
import type { AvatarProfile, BodyShape } from './types'
import { catalystRootFromContentUrl } from '../network/catalyst/CatalystClient'
import { markGuestProfileDeployed, guestProfileDeployed } from '../auth/guestIdentity'

const SKIN_HEX = ['#f5d0c5', '#e0ac69', '#c68642', '#8d5524', '#f1c27d', '#ffdbac'] as const
const HAIR_HEX = ['#1a1a1a', '#4a3728', '#b55239', '#d4a017', '#6b3fa0', '#c0c0c0', '#2c1b18'] as const
const EYE_HEX = ['#3d2314', '#4a7c59', '#3b6ea5', '#6b4f3a', '#2f2f2f', '#5b7c99'] as const

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]!
}

function hexToColor01(hex: string): { r: number; g: number; b: number } {
  const rawHex = hex.replace(/^#/, '').trim()
  const full =
    rawHex.length === 3
      ? rawHex
          .split('')
          .map((c) => c + c)
          .join('')
      : rawHex.padStart(6, '0').slice(0, 6)
  const n = Number.parseInt(full, 16)
  if (!Number.isFinite(n)) return { r: 0.8, g: 0.6, b: 0.5 }
  return {
    r: ((n >> 16) & 255) / 255,
    g: ((n >> 8) & 255) / 255,
    b: (n & 255) / 255
  }
}

function hashPick<T>(arr: readonly T[], seed: string, salt: string): T {
  let h = 2166136261
  const s = `${seed.toLowerCase()}:${salt}`
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return arr[(h >>> 0) % arr.length]!
}

function guestOutfit(address: string, displayName: string, random: boolean): AvatarProfile {
  const bodyShape: BodyShape = random
    ? Math.random() < 0.5
      ? 'male'
      : 'female'
    : hashPick(['male', 'female'] as const, address, 'shape')

  return {
    bodyShape,
    skin: random ? pick(SKIN_HEX) : hashPick(SKIN_HEX, address, 'skin'),
    hair: random ? pick(HAIR_HEX) : hashPick(HAIR_HEX, address, 'hair'),
    eyes: random ? pick(EYE_HEX) : hashPick(EYE_HEX, address, 'eyes'),
    wearables: defaultGuestWearableUrns(bodyShape),
    forceRender: [],
    emotes: [],
    fromWallet: false,
    address: address.toLowerCase(),
    displayName,
    hasClaimedName: false
  }
}

/** RFC4 announce from a local guest outfit — no lambdas fetch. */
export function commsEntityFromGuestProfile(
  profile: AvatarProfile,
  contentUrl: string
): CommsProfileEntity {
  const address = (profile.address ?? '').toLowerCase()
  const displayName = profile.displayName?.trim() || address.slice(0, 8) || 'Guest'
  const entry: LambdaAvatarEntry = {
    version: 1,
    name: displayName,
    unclaimedName: displayName,
    hasClaimedName: false,
    userId: address,
    ethAddress: address,
    avatar: {
      bodyShape: BODY_SHAPE_URN[profile.bodyShape],
      wearables: profile.wearables.length
        ? profile.wearables
        : defaultGuestWearableUrns(profile.bodyShape),
      forceRender: profile.forceRender ?? [],
      emotes: profile.emotes ?? [],
      skin: { color: hexToColor01(profile.skin) },
      hair: { color: hexToColor01(profile.hair) },
      eyes: { color: hexToColor01(profile.eyes) }
    }
  }
  return avatarEntryToCommsEntity(entry, contentUrl)
}

/** Random base-only outfit for a new guest (no NFT wearables). */
export function createRandomGuestAvatarProfile(address: string, displayName: string): AvatarProfile {
  // Stick to defaultWearableUrn catalog — always valid off-chain base-avatars.
  return guestOutfit(address, displayName, true)
}

/**
 * Deterministic dressed guest for remotes with no Catalyst profile.
 * Avoids the grey body-only silhouette and stays stable across reloads.
 */
export function createFallbackGuestAvatarProfile(address: string, displayName: string): AvatarProfile {
  return guestOutfit(address, displayName, false)
}

function contentBaseUrl(peerOrContentUrl: string): string {
  const root = catalystRootFromContentUrl(peerOrContentUrl)
  return `${root}/content`
}

function base32Encode(bytes: Uint8Array): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let bits = 0
  let value = 0
  let out = ''
  for (let i = 0; i < bytes.length; i++) {
    value = (value << 8) | bytes[i]!
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  return out
}

async function hashV1Browser(content: Uint8Array): Promise<string> {
  const input = new Uint8Array(content.byteLength)
  input.set(content)
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', input))
  const cidBytes = new Uint8Array(2 + 2 + digest.length)
  cidBytes[0] = 0x01
  cidBytes[1] = 0x55
  cidBytes[2] = 0x12
  cidBytes[3] = 0x20
  cidBytes.set(digest, 4)
  return `b${base32Encode(cidBytes)}`
}

function appendAuthChain(form: FormData, authChain: AuthChain): void {
  authChain.forEach((link, index) => {
    form.append(`authChain[${index}][type]`, String(link.type))
    form.append(`authChain[${index}][payload]`, String(link.payload))
    form.append(`authChain[${index}][signature]`, String(link.signature ?? ''))
  })
}

function buildGuestCreateMetadata(
  address: string,
  profile: AvatarProfile,
  displayName: string
): { avatars: unknown[] } {
  const wearables = profile.wearables.filter((u) => {
    const n = u.toLowerCase()
    return n.includes('base-avatars') || n.includes('off-chain')
  })
  return {
    avatars: [
      {
        userId: address,
        ethAddress: address,
        name: displayName,
        unclaimedName: displayName,
        hasClaimedName: false,
        description: '',
        email: '',
        version: 1,
        tutorialStep: 0,
        avatar: {
          bodyShape: BODY_SHAPE_URN[profile.bodyShape],
          wearables,
          forceRender: [],
          emotes: [],
          eyes: { color: hexToColor01(profile.eyes) },
          hair: { color: hexToColor01(profile.hair) },
          skin: { color: hexToColor01(profile.skin) }
        }
      }
    ]
  }
}

/**
 * Ensure this guest has a Catalyst profile (create once).
 * Safe to call repeatedly — skips if already deployed or profile already exists.
 */
export async function ensureGuestCatalystProfile(opts: {
  address: string
  identity: AuthIdentity
  displayName: string
  peerUrl?: string
}): Promise<{ created: boolean; profile: AvatarProfile | null }> {
  const address = opts.address.trim().toLowerCase()
  const peerUrl = (opts.peerUrl ?? PEER_URL).replace(/\/$/, '')
  const existing = await fetchProfileLambdaEntryCached(address, peerUrl)
  if (existing?.avatar) {
    markGuestProfileDeployed()
    return {
      created: false,
      profile: {
        bodyShape: String(existing.avatar.bodyShape ?? '').toLowerCase().includes('female')
          ? 'female'
          : 'male',
        skin: '#c68642',
        hair: '#1a1a1a',
        eyes: '#3d2314',
        wearables: Array.isArray(existing.avatar.wearables) ? existing.avatar.wearables : [],
        forceRender: [],
        emotes: [],
        fromWallet: true,
        address,
        displayName:
          existing.name?.trim() ||
          existing.unclaimedName?.trim() ||
          opts.displayName,
        hasClaimedName: existing.hasClaimedName ?? false
      }
    }
  }

  if (guestProfileDeployed()) {
    // Flag set but lambda lag — still try create once more only if no entry.
  }

  const profile = createRandomGuestAvatarProfile(address, opts.displayName)
  const metadata = buildGuestCreateMetadata(address, profile, opts.displayName)
  const entity = {
    version: 'v3' as const,
    type: EntityType.PROFILE,
    pointers: [address],
    timestamp: Date.now(),
    content: [] as Array<{ file: string; hash: string }>,
    metadata
  }
  const entityFile = new TextEncoder().encode(JSON.stringify(entity))
  const entityId = await hashV1Browser(entityFile)
  const authChain = Authenticator.signPayload(opts.identity, entityId) as AuthChain

  const form = new FormData()
  form.append('entityId', entityId)
  appendAuthChain(form, authChain)
  const entityBlob = new Uint8Array(entityFile.byteLength)
  entityBlob.set(entityFile)
  form.append(entityId, new Blob([entityBlob]), entityId)

  const contentUrl = contentBaseUrl(peerUrl)
  const response = await fetch(`${contentUrl}/entities`, {
    method: 'POST',
    body: form
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Guest profile deploy failed (${response.status})${body ? `: ${body.slice(0, 400)}` : ''}`
    )
  }

  markGuestProfileDeployed()
  clearProfileCaches(address)
  return { created: true, profile }
}
