import {
  BODY_SHAPE_URN,
  bodyShapeFromUrn,
  normalizeUrn,
  PEER_URL
} from './constants'
import { applyBundledWearableUrls, preloadBundledWearableManifests, tryBundledWearableDefinition } from './bundledWearables'
import { catalystPointerForWearableUrn } from './wearablePointers'
import { shortenAddress } from './displayName'
import type { AvatarProfile, BodyShape, WearableDefinition } from './types'

/** Removed from Catalyst — optional slots, no warn spam. */
const SILENT_MISSING_WEARABLES = new Set([
  'urn:decentraland:off-chain:base-avatars:ruby_red_dcl_earrings',
  'urn:decentraland:off-chain:base-avatars:ruby_red_earrings'
])

type CatalystContent = { file: string; hash: string }

type CatalystEntity = {
  type?: string
  content: CatalystContent[]
  metadata: Record<string, unknown>
}

export type CommsProfileEntity = {
  version: number
  serializedProfile: string
  baseUrl: string
}

type LambdaAvatarEntry = {
  version?: number
  name?: string
  unclaimedName?: string
  hasClaimedName?: boolean
  nameColor?: { r: number; g: number; b: number; a?: number }
  userId?: string
  ethAddress?: string
  avatar: {
    bodyShape?: string
    body_shape?: string
    wearables: string[]
    emotes?: Array<{ slot: number; urn: string }>
    forceRender?: string[]
    snapshots?: { face256?: string; body?: string }
    skin: { color: { r: number; g: number; b: number } }
    hair: { color: { r: number; g: number; b: number } }
    eyes: { color: { r: number; g: number; b: number } }
  }
}

type ProfileResponse = {
  avatars: LambdaAvatarEntry[]
}

function profileContentBaseUrl(contentUrl: string): string {
  return `${contentUrl.replace(/\/$/, '')}/contents/`
}

/** Lambdas store body shape on `avatar.bodyShape` (URN), not always in `wearables[]`. */
export function normalizeProfileWearables(
  bodyShapeRaw: string | undefined,
  wearables: string[]
): { bodyShape: BodyShape; wearables: string[] } {
  const raw = (bodyShapeRaw ?? '').trim()
  const bodyShape = raw ? bodyShapeFromUrn(raw) : 'male'
  const normalizedRaw = raw ? normalizeUrn(raw) : ''
  const bodyShapeUrn =
    normalizedRaw.includes('base-avatars') && normalizedRaw.includes('base')
      ? normalizedRaw
      : BODY_SHAPE_URN[bodyShape]

  const normalized = wearables.map(normalizeUrn)
  const hasBodyShape = normalized.some(
    (u) => u.includes('basemale') || u.includes('basefemale')
  )
  if (!hasBodyShape) {
    normalized.unshift(bodyShapeUrn)
  }

  return { bodyShape, wearables: normalized }
}

function normalizeProfileEmoteSlots(
  emotes: Array<{ slot: number; urn: string }>
): AvatarProfile['emotes'] {
  const usesOneBased =
    emotes.some((entry) => entry.slot === 10) ||
    (emotes.length > 0 && emotes.every((entry) => entry.slot >= 1) && !emotes.some((entry) => entry.slot === 0))

  return emotes
    .filter((entry) => entry.urn)
    .map((entry) => ({
      slot: usesOneBased ? entry.slot - 1 : entry.slot,
      urn: entry.urn
    }))
    .filter((entry) => entry.slot >= 0 && entry.slot < 10)
}

function avatarEntryToProfile(entry: LambdaAvatarEntry, address: string): AvatarProfile {
  const avatar = entry.avatar
  const displayName = entry.name?.trim() || entry.unclaimedName?.trim() || shortenAddress(address)
  const bodyShapeRaw = avatar.bodyShape ?? avatar.body_shape
  const { bodyShape, wearables } = normalizeProfileWearables(bodyShapeRaw, avatar.wearables)

  return {
    bodyShape,
    skin: rgbToHex(avatar.skin.color),
    hair: rgbToHex(avatar.hair.color),
    eyes: rgbToHex(avatar.eyes.color),
    wearables,
    forceRender: avatar.forceRender ?? [],
    emotes: normalizeProfileEmoteSlots(avatar.emotes ?? []),
    fromWallet: true,
    address,
    displayName,
    nameColor: entry.nameColor ? rgbToCss(entry.nameColor) : undefined,
    hasClaimedName: entry.hasClaimedName ?? false
  }
}

/** Parse a lambdas/comms serialized profile JSON blob for a remote peer. */
export function profileFromSerializedEntry(serializedProfile: string, address: string): AvatarProfile | null {
  try {
    const entry = JSON.parse(serializedProfile) as LambdaAvatarEntry
    const resolvedAddress = (entry.ethAddress ?? entry.userId ?? address).toLowerCase()
    return avatarEntryToProfile(entry, resolvedAddress)
  } catch {
    return null
  }
}

export function avatarEntryToCommsEntity(entry: LambdaAvatarEntry, contentUrl: string): CommsProfileEntity {
  return {
    version: typeof entry.version === 'number' && entry.version > 0 ? entry.version : 1,
    serializedProfile: JSON.stringify(entry),
    baseUrl: profileContentBaseUrl(contentUrl)
  }
}

function colorChannel(value: number): number {
  return Math.round(value <= 1 ? value * 255 : value)
}

function rgbToHex(c: { r: number; g: number; b: number }): string {
  const to = (v: number) => colorChannel(v).toString(16).padStart(2, '0')
  return `${to(c.r)}${to(c.g)}${to(c.b)}`
}

function rgbToCss(c: { r: number; g: number; b: number }): string {
  return `rgb(${colorChannel(c.r)}, ${colorChannel(c.g)}, ${colorChannel(c.b)})`
}

type RawRepresentation = {
  bodyShapes: string[]
  mainFile: string
  contents: Array<string | { key: string; url: string }>
}

function contentFileLeaf(file: string): string {
  const clean = file.split('?')[0]!.split('#')[0]!
  const parts = clean.split('/')
  return decodeURIComponent(parts[parts.length - 1] ?? clean)
}

function entityToWearable(entity: CatalystEntity, peerUrl: string): WearableDefinition | null {
  const metadata = entity.metadata as {
    id?: string
    data?: Omit<WearableDefinition['data'], 'representations'> & { representations: RawRepresentation[] }
  }
  if (!metadata?.data?.representations?.length) return null

  const id = metadata.id ?? 'unknown'

  return {
    id,
    data: {
      ...metadata.data,
      representations: metadata.data.representations.map((rep) => ({
        bodyShapes: rep.bodyShapes,
        mainFile: rep.mainFile,
        contents: rep.contents
          .map((entry) => {
            const key = typeof entry === 'string' ? entry : entry.key
            const hash =
              entity.content.find((c) => c.file === key || contentFileLeaf(c.file) === key)?.hash ??
              entity.content.find(
                (c) => contentFileLeaf(c.file).toLowerCase() === contentFileLeaf(key).toLowerCase()
              )?.hash
            if (!hash) return null
            return {
              key,
              url: `${peerUrl}/content/contents/${hash}`
            }
          })
          .filter((c): c is { key: string; url: string } => c !== null)
      }))
    }
  }
}

export async function fetchWearablesByUrns(urns: string[], peerUrl = PEER_URL): Promise<WearableDefinition[]> {
  if (!urns.length) return []

  const pointerByOriginal = new Map<string, string>()
  for (const urn of urns) {
    pointerByOriginal.set(normalizeUrn(urn), catalystPointerForWearableUrn(urn))
  }
  const pointers = [...new Set(pointerByOriginal.values())]

  await preloadBundledWearableManifests(pointers)

  const bundled = pointers
    .map((pointer) => tryBundledWearableDefinition(pointer))
    .filter((w): w is WearableDefinition => !!w)
  const bundledIds = new Set(bundled.map((w) => w.id.toLowerCase()))

  const missingPointers = pointers.filter((pointer) => !bundledIds.has(pointer.toLowerCase()))
  let fetched: WearableDefinition[] = []
  if (missingPointers.length) {
    const res = await fetch(`${peerUrl}/content/entities/active`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pointers: missingPointers })
    })
    if (!res.ok) throw new Error(`Catalyst fetch failed: ${res.status}`)
    const entities = (await res.json()) as CatalystEntity[]
    fetched = entities
      .map((e) => entityToWearable(e, peerUrl))
      .filter((w): w is WearableDefinition => !!w)
      .map((w) => applyBundledWearableUrls(w))
  }

  const byPointer = new Map<string, WearableDefinition>()
  for (const wearable of [...bundled, ...fetched]) {
    byPointer.set(wearable.id.toLowerCase(), wearable)
  }

  const wearables: WearableDefinition[] = []
  const missing: string[] = []
  for (const urn of urns) {
    const pointer = pointerByOriginal.get(normalizeUrn(urn)) ?? catalystPointerForWearableUrn(urn)
    const hit = byPointer.get(pointer.toLowerCase())
    if (hit) {
      wearables.push(hit)
    } else {
      missing.push(pointer)
    }
  }

  const loudMissing = [...new Set(missing)].filter((pointer) => !SILENT_MISSING_WEARABLES.has(pointer.toLowerCase()))
  if (loudMissing.length) {
    console.warn('Catalyst missing wearables:', loudMissing)
  }

  return wearables
}

const profileCache = new Map<string, Promise<AvatarProfile | null>>()
const commsProfileCache = new Map<string, Promise<CommsProfileEntity | null>>()
const profileFaceCache = new Map<string, Promise<string | null>>()

/** Resolve Catalyst `face256` snapshot — URL or IPFS entity id. */
export function resolveFaceSnapshotUrl(raw: unknown): string | null {
  const value = String(raw ?? '').trim()
  if (!value) return null
  if (/^https?:\/\//i.test(value)) return value
  return `https://profile-images.decentraland.org/entities/${value}/face.png`
}

export async function fetchProfileFaceUrl(profileId: string, peerUrl = PEER_URL): Promise<string | null> {
  const address = profileId.toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(address)) return null

  let pending = profileFaceCache.get(address)
  if (!pending) {
    pending = (async () => {
      const res = await fetch(profileRequestUrl(peerUrl, address))
      if (!res.ok) return null
      const data = (await res.json()) as ProfileResponse
      const entry = data.avatars?.[0]
      return resolveFaceSnapshotUrl(entry?.avatar?.snapshots?.face256)
    })()
    profileFaceCache.set(address, pending)
  }
  return pending
}

export async function fetchProfileCached(profileId: string, peerUrl = PEER_URL): Promise<AvatarProfile | null> {
  const key = profileId.toLowerCase()
  let pending = profileCache.get(key)
  if (!pending) {
    pending = fetchProfile(key, peerUrl)
    profileCache.set(key, pending)
  }
  return pending
}

export async function fetchCommsProfileEntityCached(
  profileId: string,
  lambdasUrl: string,
  contentUrl: string
): Promise<CommsProfileEntity | null> {
  const key = profileId.toLowerCase()
  let pending = commsProfileCache.get(key)
  if (!pending) {
    pending = fetchCommsProfileEntity(key, lambdasUrl, contentUrl)
    commsProfileCache.set(key, pending)
  }
  return pending
}

export async function fetchCommsProfileEntity(
  profileId: string,
  lambdasUrl: string,
  contentUrl: string
): Promise<CommsProfileEntity | null> {
  const entry = await fetchLambdaAvatarEntry(profileId, lambdasUrl)
  if (!entry) return null
  return avatarEntryToCommsEntity(entry, contentUrl)
}

export function profileRequestUrl(baseUrl: string, address: string): string {
  const base = baseUrl.replace(/\/$/, '')
  if (base.endsWith('/lambdas')) return `${base}/profiles/${address.toLowerCase()}`
  return `${base}/lambdas/profiles/${address.toLowerCase()}`
}

async function fetchLambdaAvatarEntry(
  profileId: string,
  lambdasUrl: string
): Promise<LambdaAvatarEntry | null> {
  if (!profileId || profileId === 'default') return null

  const address = profileId.toLowerCase()
  if (!/^0x[a-f0-9]{40}$/.test(address)) return null

  const res = await fetch(profileRequestUrl(lambdasUrl, address))
  if (!res.ok) {
    console.warn(`Profile fetch failed for ${address}: ${res.status}`)
    return null
  }

  const data = (await res.json()) as ProfileResponse
  const entry = data.avatars?.[0]
  if (!entry?.avatar) {
    console.warn(`Profile ${address} has no avatar data`)
    return null
  }

  return entry
}

export async function fetchProfile(profileId: string, peerUrl = PEER_URL): Promise<AvatarProfile | null> {
  const entry = await fetchLambdaAvatarEntry(profileId, peerUrl)
  if (!entry) return null
  return avatarEntryToProfile(entry, profileId.toLowerCase())
}

function logResolvedProfile(profileId: string, profile: AvatarProfile): void {
  console.info(
    `[avatar] profile ${profileId}: ${profile.bodyShape}, ${profile.wearables.length} equipped wearables`
  )
}

export async function resolveAvatarProfile(
  profileId: string | undefined,
  shapeOverride?: BodyShape
): Promise<AvatarProfile> {
  const fetched = profileId ? await fetchProfile(profileId) : null

  if (fetched) {
    const bodyShape = shapeOverride ?? fetched.bodyShape
    const wearables = shapeOverride
      ? normalizeProfileWearables(BODY_SHAPE_URN[shapeOverride], fetched.wearables).wearables
      : fetched.wearables

    const profile: AvatarProfile = {
      ...fetched,
      bodyShape,
      wearables
    }
    if (profileId) logResolvedProfile(profileId.toLowerCase(), profile)
    return profile
  }

  const { bodyShape, wearables } = normalizeProfileWearables(
    shapeOverride ? BODY_SHAPE_URN[shapeOverride] : undefined,
    []
  )

  const profile: AvatarProfile = {
    bodyShape: shapeOverride ?? bodyShape,
    skin: 'cc9b76',
    hair: '3a3a3a',
    eyes: '3a3a3a',
    wearables,
    forceRender: [],
    emotes: [],
    fromWallet: false,
    address: profileId?.toLowerCase()
  }

  if (profileId) {
    console.warn(`[avatar] profile fetch failed for ${profileId} — using defaults`)
  }

  return profile
}

export function isTextureRepresentation(rep: WearableDefinition['data']['representations'][0]): boolean {
  return rep.mainFile.endsWith('.png')
}

export function getWearableRepresentation(wearable: WearableDefinition, bodyShape: BodyShape) {
  const target = bodyShape === 'female' ? 'BaseFemale' : 'BaseMale'
  const rep = wearable.data.representations.find((r) =>
    r.bodyShapes.some((s) => s.toLowerCase().includes(target.toLowerCase()))
  )
  if (!rep) throw new Error(`No ${target} representation for ${wearable.id}`)
  return rep
}

export function hasRepresentation(wearable: WearableDefinition, bodyShape: BodyShape): boolean {
  try {
    getWearableRepresentation(wearable, bodyShape)
    return true
  } catch {
    return false
  }
}

export function getMainFileUrl(wearable: WearableDefinition, bodyShape: BodyShape): string {
  const rep = getWearableRepresentation(wearable, bodyShape)
  if (isTextureRepresentation(rep)) throw new Error(`Wearable ${wearable.id} is texture-only`)
  const content = rep.contents.find((c) => c.key === rep.mainFile)
  if (!content) throw new Error(`Missing main file for ${wearable.id}`)
  return content.url
}

export function contentMappings(wearable: WearableDefinition, bodyShape: BodyShape): Record<string, string> {
  const rep = getWearableRepresentation(wearable, bodyShape)
  const out: Record<string, string> = {}
  for (const file of rep.contents) out[file.key] = file.url
  return out
}
