import { Authenticator } from '@dcl/crypto'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { AuthChain } from '@dcl/schemas'
import { EntityType } from '@dcl/schemas'
import {
  assetUrnFromCompleteUrn,
  BODY_SHAPE_URN,
  normalizeUrn,
  PEER_URL
} from './constants'
import {
  clearProfileCaches,
  fetchProfileLambdaEntryCached,
  type LambdaAvatarEntry
} from './peerApi'
import type { AvatarProfile } from './types'
import { catalystRootFromContentUrl } from '../network/catalyst/CatalystClient'
import { expandOwnedWearableRows } from './ownedWearables'

export type DeployProfileResult = {
  entityId: string
  contentUrl: string
  /** Item URNs that were actually deployed (with real tokenIds). */
  wearables: string[]
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

/** Wearables list for Catalyst — body shape lives in `avatar.bodyShape`, not the array. */
export function wearablesForProfileDeploy(profile: AvatarProfile): string[] {
  return profile.wearables.filter((urn) => {
    const n = normalizeUrn(urn)
    return !n.includes('basemale') && !n.includes('basefemale')
  })
}

/**
 * Dirty-key for Catalyst profile deploy. Covers every field written by
 * `buildProfileDeployPayload` that the backpack can edit:
 * bodyShape, skin/hair/eyes colors, equipped wearables, and emote slots.
 * bodyShape URNs are omitted from the wearables segment (they live in bodyShape).
 */
export function profileDeployFingerprint(profile: AvatarProfile): string {
  const wearables = wearablesForProfileDeploy(profile)
    .map((u) => u.toLowerCase())
    .sort()
    .join('|')
  const emotes = (profile.emotes ?? [])
    .map((e) => `${e.slot}:${e.urn.toLowerCase()}`)
    .sort()
    .join('|')
  const colors = `${profile.skin}:${profile.hair}:${profile.eyes}`.toLowerCase()
  return `${profile.bodyShape}::${colors}::${wearables}||${emotes}`
}

function isOffChainWearable(urn: string): boolean {
  const n = normalizeUrn(urn)
  return (
    n.includes('off-chain') ||
    n.includes('base-avatars') ||
    n.includes('base-emotes') ||
    !n.includes('collections-')
  )
}

/** collections-v1/v2 item pointer includes tokenId (7+ segments). */
function hasItemTokenId(urn: string): boolean {
  const parts = normalizeUrn(urn).split(':')
  if (parts[3] === 'collections-v1' || parts[3] === 'collections-v2') {
    return parts.length >= 7 && Boolean(parts[6]?.length)
  }
  if (parts[3] === 'collections-thirdparty') {
    return parts.length >= 8
  }
  return true
}

async function fetchOwnedItemUrns(address: string, lambdasUrl: string): Promise<string[]> {
  const base = lambdasUrl.replace(/\/$/, '')
  const addr = address.toLowerCase()
  const out: string[] = []

  const ingestRows = (raw: unknown): void => {
    const rows = Array.isArray(raw)
      ? raw
      : raw &&
          typeof raw === 'object' &&
          Array.isArray((raw as { elements?: unknown }).elements)
        ? (raw as { elements: unknown[] }).elements
        : null
    if (!rows) return
    for (const e of expandOwnedWearableRows(rows as Parameters<typeof expandOwnedWearableRows>[0])) {
      if (e.urn) out.push(normalizeUrn(e.urn))
    }
  }

  // Primary: /users/{addr}/wearables includes individualData with real tokenIds.
  try {
    const res = await fetch(`${base}/users/${addr}/wearables`)
    if (res.ok) ingestRows(await res.json())
  } catch {
    /* try other peers / endpoints */
  }

  // Secondary: wearables-by-owner (often asset-only — only useful if individualData present).
  if (!out.some((u) => hasItemTokenId(u))) {
    try {
      const res = await fetch(`${base}/collections/wearables-by-owner/${addr}`)
      if (res.ok) ingestRows(await res.json())
    } catch {
      /* ignore */
    }
  }

  // Retry on other Catalyst peers when tokenIds still missing (peer lag / empty individualData).
  if (!out.some((u) => hasItemTokenId(u))) {
    for (const peer of [
      'https://peer.decentraland.org/lambdas',
      'https://peer-ec1.decentraland.org/lambdas',
      'https://peer-ec2.decentraland.org/lambdas'
    ]) {
      if (peer === base) continue
      try {
        const res = await fetch(`${peer}/users/${addr}/wearables`)
        if (res.ok) {
          ingestRows(await res.json())
          if (out.some((u) => hasItemTokenId(u))) break
        }
      } catch {
        /* next peer */
      }
    }
  }

  // Optional NFT API (may fail DNS in some networks).
  if (!out.some((u) => hasItemTokenId(u))) {
    try {
      const url = new URL('https://nft-api.decentraland.org/v1/nfts')
      url.searchParams.set('owner', addr)
      url.searchParams.set('category', 'wearable')
      url.searchParams.set('first', '1000')
      const res = await fetch(url.toString())
      if (res.ok) {
        const raw = (await res.json()) as {
          data?: Array<{
            urn?: string
            tokenId?: string
            item?: { urn?: string }
            nft?: { urn?: string; tokenId?: string }
          }>
        }
        for (const row of raw.data ?? []) {
          const full =
            row.urn?.trim() ||
            row.nft?.urn?.trim() ||
            (row.item?.urn && (row.tokenId ?? row.nft?.tokenId)
              ? `${row.item.urn}:${row.tokenId ?? row.nft?.tokenId}`
              : '')
          if (full) out.push(normalizeUrn(full))
        }
      }
    } catch {
      /* ignore */
    }
  }

  return [...new Set(out)]
}

/**
 * Map equipped wearables to **owned item** URNs (real tokenIds).
 * Never invents `:0` — that fails Catalyst ownership checks.
 *
 * Priority: owned inventory (individualData) → currently deployed profile → off-chain only.
 * Blockchain wearables that cannot be resolved to an owned token are **dropped** from the
 * deploy list (Catalyst would reject them anyway).
 */
export async function resolveItemWearableUrnsForDeploy(
  address: string,
  profile: AvatarProfile,
  lambdasUrl: string,
  /** Wearables already on the live Catalyst profile (trusted tokenIds). */
  deployedWearables: string[] = []
): Promise<string[]> {
  const equipped = wearablesForProfileDeploy(profile)

  const ownedByAsset = new Map<string, string>()
  try {
    const owned = await fetchOwnedItemUrns(address, lambdasUrl)
    for (const urn of owned) {
      if (!hasItemTokenId(urn) && !isOffChainWearable(urn)) continue
      const asset = assetUrnFromCompleteUrn(urn)
      // Prefer first owned token for this asset (any valid tokenId).
      if (!ownedByAsset.has(asset)) ownedByAsset.set(asset, urn)
    }
  } catch (err) {
    console.warn('[deployProfile] owned inventory fetch failed', err)
  }

  const deployedByAsset = new Map<string, string>()
  for (const urn of deployedWearables) {
    const n = normalizeUrn(urn)
    if (isOffChainWearable(n)) continue
    if (!hasItemTokenId(n)) continue
    const asset = assetUrnFromCompleteUrn(n)
    if (!deployedByAsset.has(asset)) deployedByAsset.set(asset, n)
  }

  const resolved: string[] = []
  const dropped: string[] = []

  for (const urn of equipped) {
    const n = normalizeUrn(urn)
    if (isOffChainWearable(n)) {
      resolved.push(n)
      continue
    }

    const asset = assetUrnFromCompleteUrn(n)
    const owned = ownedByAsset.get(asset)
    if (owned) {
      resolved.push(owned)
      continue
    }

    // Keep currently deployed token if still equipped (user still owns it).
    const deployed = deployedByAsset.get(asset)
    if (deployed) {
      resolved.push(deployed)
      continue
    }

    // Equipped session urn already has a real tokenId — keep it.
    if (hasItemTokenId(n)) {
      resolved.push(n)
      continue
    }

    dropped.push(n)
  }

  if (dropped.length) {
    console.warn(
      '[deployProfile] dropped blockchain wearables without owned tokenId:',
      dropped
    )
  }

  return resolved
}

function buildMetadataFromProfile(
  entry: LambdaAvatarEntry,
  profile: AvatarProfile,
  address: string,
  wearables: string[]
): { avatars: unknown[] } {
  const avatar = entry.avatar ?? ({} as LambdaAvatarEntry['avatar'])
  // Omit snapshots so we don't re-upload face/body images (auth-site pattern).
  const { snapshots: _snap, ...avatarRest } = avatar as LambdaAvatarEntry['avatar'] & {
    snapshots?: unknown
  }

  return {
    avatars: [
      {
        ...entry,
        version: (typeof entry.version === 'number' ? entry.version : 0) + 1,
        userId: address,
        ethAddress: address,
        name: entry.name?.trim() || profile.displayName || entry.unclaimedName || address.slice(0, 8),
        hasClaimedName: entry.hasClaimedName ?? profile.hasClaimedName ?? false,
        avatar: {
          ...avatarRest,
          bodyShape: BODY_SHAPE_URN[profile.bodyShape],
          wearables,
          forceRender: profile.forceRender ?? [],
          emotes: (profile.emotes ?? []).map((e) => ({ slot: e.slot, urn: e.urn })),
          eyes: { color: hexToColor01(profile.eyes) },
          hair: { color: hexToColor01(profile.hair) },
          skin: { color: hexToColor01(profile.skin) }
        }
      }
    ]
  }
}

function contentBaseUrl(peerOrContentUrl: string): string {
  const root = catalystRootFromContentUrl(peerOrContentUrl)
  return `${root}/content`
}

/** RFC 4648 base32 (lowercase, no padding) for multibase 'b'. */
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
  if (bits > 0) {
    out += alphabet[(value << (5 - bits)) & 31]
  }
  return out
}

/**
 * Browser-safe CIDv1 (raw + sha256) — matches `@dcl/hashing` `hashV1` for Uint8Array
 * without Node `crypto.createHash` (broken under Vite).
 */
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

async function buildProfileEntity(opts: {
  pointer: string
  metadata: unknown
  timestamp: number
}): Promise<{ entityId: string; entityFile: Uint8Array }> {
  const entity = {
    version: 'v3' as const,
    type: EntityType.PROFILE,
    pointers: [opts.pointer],
    timestamp: opts.timestamp,
    content: [] as Array<{ file: string; hash: string }>,
    metadata: opts.metadata
  }
  const entityFile = new TextEncoder().encode(JSON.stringify(entity))
  const entityId = await hashV1Browser(entityFile)
  return { entityId, entityFile }
}

function appendAuthChain(form: FormData, authChain: AuthChain): void {
  authChain.forEach((link, index) => {
    form.append(`authChain[${index}][type]`, String(link.type))
    form.append(`authChain[${index}][payload]`, String(link.payload))
    form.append(`authChain[${index}][signature]`, String(link.signature ?? ''))
  })
}

/**
 * Deploy an updated profile entity to Catalyst (pointer = wallet address).
 * @see https://docs.decentraland.org/contributor/content/entity-types/profiles#pointers
 */
export async function deployAvatarProfile(opts: {
  address: string
  identity: AuthIdentity
  profile: AvatarProfile
  peerUrl?: string
}): Promise<DeployProfileResult> {
  const address = opts.address.trim().toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(address)) {
    throw new Error('Invalid wallet address for profile deploy')
  }

  const peerUrl = (opts.peerUrl ?? PEER_URL).replace(/\/$/, '')
  const contentUrl = contentBaseUrl(peerUrl)

  const entry = await fetchProfileLambdaEntryCached(address, peerUrl)
  if (!entry?.avatar) {
    throw new Error('Could not load current Catalyst profile to update')
  }

  const lambdasUrl = peerUrl.endsWith('/lambdas') ? peerUrl : `${peerUrl}/lambdas`
  const deployedWearables = Array.isArray(entry.avatar.wearables) ? entry.avatar.wearables : []
  const wearables = await resolveItemWearableUrnsForDeploy(
    address,
    opts.profile,
    lambdasUrl,
    deployedWearables
  )

  if (!wearables.length) {
    throw new Error('No valid wearables to deploy — could not resolve owned token IDs')
  }

  const metadata = buildMetadataFromProfile(entry, opts.profile, address, wearables)
  const { entityId, entityFile } = await buildProfileEntity({
    pointer: address,
    metadata,
    timestamp: Date.now()
  })

  const authChain = Authenticator.signPayload(opts.identity, entityId) as AuthChain

  const form = new FormData()
  form.append('entityId', entityId)
  appendAuthChain(form, authChain)
  const entityBlob = new Uint8Array(entityFile.byteLength)
  entityBlob.set(entityFile)
  form.append(entityId, new Blob([entityBlob]), entityId)

  const response = await fetch(`${contentUrl}/entities`, {
    method: 'POST',
    body: form
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new Error(`Profile deploy failed (${response.status})${body ? `: ${body.slice(0, 400)}` : ''}`)
  }

  clearProfileCaches(address)
  return { entityId, contentUrl, wearables }
}
