import { assetUrnFromCompleteUrn, BODY_SHAPE_URN, PEER_URL } from './constants'
import type { AssetCache } from '../rendering/AssetCache'
import type { CachedGltf } from '../rendering/AssetCache'
import type { ContentFile } from '../dcl/content/types'
import type { AvatarProfile, BodyShape } from './types'
import { fetchEntityContentById } from '../network/catalyst/CatalystClient'
import { getActiveSceneManifest } from '../rendering/DclTextureResolver'

type CatalystContent = { file: string; hash: string }

type EmoteRepresentation = {
  bodyShapes: string[]
  mainFile: string
  contents: string[]
}

type CatalystEmoteEntity = {
  content: CatalystContent[]
  metadata: {
    id?: string
    name?: string
    emoteDataADR74?: {
      loop?: boolean
      representations?: EmoteRepresentation[]
    }
  }
}

export type ResolvedProfileEmote = {
  url: string
  loop: boolean
  urn: string
  /** Catalyst entity files — required for particle/prop texture resolution. */
  content: ContentFile[]
  peerUrl: string
}

export type EmoteWheelSlot = {
  key: string
  label: string
  /** URN or base-emote slug — passed to playback + wire encode. */
  id: string
}

const WHEEL_KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'] as const

const EMOTE_LABELS: Record<string, string> = {
  wave: 'Wave',
  fistpump: 'Fist Pump',
  robot: 'Robot',
  raiseHand: 'Raise Hand',
  clap: 'Clap',
  money: 'Money',
  kiss: 'Kiss',
  tik: 'Tik',
  hammer: 'Hammer',
  tektonik: 'Tektonik',
  dontsee: "Don't See",
  handsair: 'Hands Air',
  shrug: 'Shrug',
  disco: 'Disco',
  dab: 'Dab',
  headexplode: 'Head Explode',
  dance: 'Dance',
  love: 'Love',
  fashion: 'Fashion'
}

/** Bundled wearable-preview filenames in `public/avatar/emotes/`. */
const BUNDLED_EMOTE_FILES: Record<string, string> = {
  idle: 'idle.glb',
  walk: 'walk.glb',
  run: 'run.glb',
  jump: 'jump.glb',
  wave: 'wave.glb',
  fistpump: 'fist-pump.glb',
  'fist-pump': 'fist-pump.glb',
  robot: 'robot.glb',
  raiseHand: 'raiseHand.glb',
  clap: 'clap.glb',
  money: 'money.glb',
  kiss: 'kiss.glb',
  tik: 'tik.glb',
  hammer: 'hammer.glb',
  tektonik: 'tektonik.glb',
  dontsee: 'dontsee.glb',
  handsair: 'handsair.glb',
  shrug: 'shrug.glb',
  disco: 'disco.glb',
  dab: 'dab.glb',
  headexplode: 'head-explode.glb',
  'head-explode': 'head-explode.glb',
  dance: 'dance.glb',
  love: 'love.glb',
  fashion: 'fashion.glb',
  buttonDown: 'buttonDown.glb',
  'button-down': 'buttonDown.glb',
  buttonFront: 'buttonFront.glb',
  'button-front': 'buttonFront.glb',
  getHit: 'getHit.glb',
  'get-hit': 'getHit.glb',
  knockOut: 'knockOut.glb',
  'knock-out': 'knockOut.glb',
  lever: 'lever.glb',
  openChest: 'openChest.glb',
  'open-chest': 'openChest.glb',
  openDoor: 'openDoor.glb',
  'open-door': 'openDoor.glb',
  punch: 'punch.glb',
  push: 'push.glb',
  swingWeaponOneHand: 'swingWeaponOneHand.glb',
  'swing-weapon-one-hand': 'swingWeaponOneHand.glb',
  swingWeaponTwoHands: 'swingWeaponTwoHands.glb',
  'swing-weapon-two-hands': 'swingWeaponTwoHands.glb',
  throw: 'throw.glb',
  sittingChair1: 'sittingChair1.glb',
  'sitting-chair-1': 'sittingChair1.glb',
  sittingChair2: 'sittingChair2.glb',
  'sitting-chair-2': 'sittingChair2.glb',
  sittingGround1: 'sittingGround1.glb',
  'sitting-ground-1': 'sittingGround1.glb',
  sittingGround2: 'sittingGround2.glb',
  'sitting-ground-2': 'sittingGround2.glb'
}

/** All known emote slug keys — used to silently skip emote refs used as GltfContainer.src. */
export const BUNDLED_EMOTE_SLUGS: ReadonlySet<string> = new Set(Object.keys(BUNDLED_EMOTE_FILES))

/** Map from emote slug to GLB filename (e.g. "sittingChair1" -> "sittingChair1.glb"). */
export const BUNDLED_EMOTE_FILES_MAP: ReadonlyMap<string, string> = new Map(Object.entries(BUNDLED_EMOTE_FILES))

const DEFAULT_WHEEL_BY_SLOT: Record<number, string> = {
  0: 'wave',
  1: 'fistpump',
  2: 'robot',
  3: 'raiseHand',
  4: 'clap',
  5: 'money',
  6: 'kiss',
  7: 'tik',
  8: 'hammer',
  9: 'tektonik'
}

const emoteResolveCache = new Map<string, Promise<ResolvedProfileEmote | null>>()
const emoteLabelCache = new Map<string, Promise<string | null>>()

const SCENE_EMOTE_URN_PREFIX = 'urn:decentraland:off-chain:scene-emote:'
const SCENE_EMOTE_PAYLOAD_RE =
  /^(bafkrei[a-z0-9]+|bafy[a-z0-9]+|Qm[a-z0-9]+)-(bafkrei[a-z0-9]+|bafy[a-z0-9]+|Qm[a-z0-9]+)-(true|false)$/

export type ParsedSceneEmoteUrn = {
  entityHash: string
  animationHash: string
  loop: boolean
}

export function isSceneEmoteUrn(ref: string): boolean {
  return ref.trim().toLowerCase().startsWith(SCENE_EMOTE_URN_PREFIX)
}

export function parseSceneEmoteUrn(ref: string): ParsedSceneEmoteUrn | null {
  const lower = ref.trim().toLowerCase()
  if (!lower.startsWith(SCENE_EMOTE_URN_PREFIX)) return null
  const match = lower.slice(SCENE_EMOTE_URN_PREFIX.length).match(SCENE_EMOTE_PAYLOAD_RE)
  if (!match) return null
  return {
    entityHash: match[1]!,
    animationHash: match[2]!,
    loop: match[3] === 'true'
  }
}

function normalizeSceneContentPath(path: string): string {
  return decodeURIComponent(path.trim().replace(/^\.\//, '').replace(/\\/g, '/')).toLowerCase()
}

/** Map `triggerSceneEmote({ src })` file path → scene-emote URN for local playback. */
export function resolveSceneEmoteFromSrc(
  src: string,
  loop = false
): { urn: string; loop: boolean } | null {
  const manifest = getActiveSceneManifest()
  if (!manifest?.entityId) return null

  const want = normalizeSceneContentPath(src)
  const entry = manifest.content.find((file) => {
    const normalized = normalizeSceneContentPath(file.file)
    const leaf = normalizeSceneContentPath(file.file.split('/').pop() ?? file.file)
    return normalized === want || leaf === want
  })
  if (!entry) return null

  return {
    urn: `${SCENE_EMOTE_URN_PREFIX}${manifest.entityId}-${entry.hash}-${loop ? 'true' : 'false'}`,
    loop
  }
}

export function normalizeEmoteId(emoteId: string): string {
  const trimmed = emoteId.trim()
  if (!trimmed) return ''
  if (trimmed.startsWith('urn:')) {
    const parts = trimmed.toLowerCase().split(':')
    return parts[parts.length - 1] ?? trimmed
  }
  return trimmed
}

export function baseEmoteUrn(emoteId: string): string {
  const trimmed = emoteId.trim()
  if (trimmed.startsWith('urn:')) return trimmed.toLowerCase()
  const slug = normalizeEmoteId(trimmed)
  return `urn:decentraland:off-chain:base-emotes:${slug}`
}

/** Slug from `urn:…:base-emotes:{slug}` or plain slug refs — not collections-v2 token ids. */
export function baseEmoteSlugFromRef(ref: string): string | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const lower = trimmed.toLowerCase()
  if (lower.startsWith('urn:decentraland:off-chain:base-emotes:')) {
    return lower.split(':').pop() ?? null
  }
  if (!lower.startsWith('urn:')) {
    return normalizeEmoteId(trimmed)
  }
  return null
}

export function catalystPointerForEmoteUrn(urn: string): string {
  const normalized = urn.trim().toLowerCase()
  if (isSceneEmoteUrn(normalized)) return normalized
  const baseSlug = baseEmoteSlugFromRef(normalized)
  if (baseSlug) {
    return `urn:decentraland:off-chain:base-emotes:${baseSlug}`
  }
  return assetUrnFromCompleteUrn(normalized)
}

export function emoteLabel(ref: string, fallback?: string): string {
  const slug = baseEmoteSlugFromRef(ref)
  if (slug && EMOTE_LABELS[slug]) return EMOTE_LABELS[slug]
  if (fallback) return fallback
  const token = normalizeEmoteId(ref)
  return EMOTE_LABELS[token] ?? token.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
}

function normalizeWheelSlot(slot: number): number | null {
  if (slot >= 0 && slot < 10) return slot
  if (slot >= 1 && slot <= 10) return slot - 1
  return null
}

/** Ten wheel slots — profile equipped emotes per slot, else default base-emotes. */
export function buildEmoteWheelSlots(profile?: AvatarProfile | null): EmoteWheelSlot[] {
  const equipped = new Map<number, string>()
  for (const entry of profile?.emotes ?? []) {
    const index = normalizeWheelSlot(entry.slot)
    if (index !== null && entry.urn) {
      equipped.set(index, entry.urn)
    }
  }

  return WHEEL_KEYS.map((key, index) => {
    const ref = equipped.get(index) ?? DEFAULT_WHEEL_BY_SLOT[index] ?? 'wave'
    const fallbackLabel = EMOTE_LABELS[DEFAULT_WHEEL_BY_SLOT[index] ?? 'wave']
    return { key, label: emoteLabel(ref, fallbackLabel), id: ref }
  })
}

/** Resolve display names for profile-owned emotes (Catalyst metadata). */
export async function hydrateEmoteWheelSlots(
  profile?: AvatarProfile | null,
  peerUrl = PEER_URL
): Promise<EmoteWheelSlot[]> {
  const slots = buildEmoteWheelSlots(profile)
  const bodyShape = profile?.bodyShape ?? 'male'

  return Promise.all(
    slots.map(async (slot) => {
      if (!slot.id.startsWith('urn:')) return slot
      const baseSlug = baseEmoteSlugFromRef(slot.id)
      if (baseSlug && BUNDLED_EMOTE_FILES[baseSlug]) return slot

      const label = await resolveEmoteDisplayName(slot.id, bodyShape, peerUrl)
      return label ? { ...slot, label } : slot
    })
  )
}

export async function resolveEmoteDisplayName(
  emoteRef: string,
  bodyShape: BodyShape,
  peerUrl = PEER_URL
): Promise<string | null> {
  const ref = emoteRef.trim()
  if (!ref) return null

  const baseSlug = baseEmoteSlugFromRef(ref)
  if (baseSlug && EMOTE_LABELS[baseSlug]) return EMOTE_LABELS[baseSlug]

  const cacheKey = `${peerUrl}|${bodyShape}|label|${ref.toLowerCase()}`
  let pending = emoteLabelCache.get(cacheKey)
  if (!pending) {
    pending = (async () => {
      const pointer = catalystPointerForEmoteUrn(ref)
      const res = await fetch(`${peerUrl.replace(/\/$/, '')}/content/entities/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pointers: [pointer] })
      })
      if (!res.ok) return null
      const entities = (await res.json()) as CatalystEmoteEntity[]
      const name = entities[0]?.metadata?.name?.trim()
      return name || null
    })()
    emoteLabelCache.set(cacheKey, pending)
  }
  return pending
}

function bundledEmoteUrl(emoteRef: string): string | null {
  const slug = baseEmoteSlugFromRef(emoteRef) ?? normalizeEmoteId(emoteRef)
  const file = BUNDLED_EMOTE_FILES[slug]
  return file ? `/avatar/emotes/${file}` : null
}

/** Base-emote slugs that loop when bundled fallback is used (Catalyst metadata preferred when available). */
function bundledEmoteLoop(slug: string): boolean {
  if (/^sitting/i.test(slug)) return true
  return (
    slug === 'dance' ||
    slug === 'robot' ||
    slug === 'tektonik' ||
    slug === 'disco' ||
    slug === 'handsair' ||
    slug === 'fashion' ||
    slug === 'dab' ||
    slug === 'clap' ||
    slug === 'money'
  )
}

function pickRepresentation(reps: EmoteRepresentation[], bodyShape: BodyShape): EmoteRepresentation | null {
  const target = BODY_SHAPE_URN[bodyShape]
  const hit = reps.find((rep) => rep.bodyShapes.some((shape) => shape.toLowerCase() === target.toLowerCase()))
  return hit ?? reps[0] ?? null
}

function emoteGlbUrl(entity: CatalystEmoteEntity, rep: EmoteRepresentation, peerUrl: string): string | null {
  const main = entity.content.find((entry) => entry.file === rep.mainFile)
  if (main?.hash && /\.glb$/i.test(main.file)) {
    return catalystAssetUrl(peerUrl, main.hash)
  }
  const fallback = entity.content.find((entry) => /\.glb$/i.test(entry.file))
  if (fallback?.hash) return catalystAssetUrl(peerUrl, fallback.hash)
  return main?.hash ? catalystAssetUrl(peerUrl, main.hash) : null
}

function catalystAssetUrl(peerUrl: string, hash: string): string {
  const root = peerUrl.replace(/\/$/, '')
  return `${root}/content/contents/${encodeURIComponent(hash)}`
}

function sceneEmoteFromContent(
  urn: string,
  parsed: ParsedSceneEmoteUrn,
  content: ContentFile[],
  assetUrl: (hash: string) => string,
  peerUrl: string
): ResolvedProfileEmote | null {
  if (!content.some((entry) => entry.hash === parsed.animationHash)) return null
  return {
    url: assetUrl(parsed.animationHash),
    loop: parsed.loop,
    urn: urn.trim().toLowerCase(),
    content,
    peerUrl: peerUrl.replace(/\/$/, '')
  }
}

/** Scene-bundled emote GLBs — not Catalyst emote entities (no emoteDataADR74). */
async function resolveSceneEmoteUrn(urn: string, peerUrl: string): Promise<ResolvedProfileEmote | null> {
  const parsed = parseSceneEmoteUrn(urn)
  if (!parsed) return null

  const active = getActiveSceneManifest()
  if (active) {
    const sameScene = !active.entityId || active.entityId === parsed.entityHash
    if (sameScene) {
      const hit = sceneEmoteFromContent(urn, parsed, active.content, active.assetUrl, peerUrl)
      if (hit) return hit
    }
  }

  const remoteContent = await fetchEntityContentById(peerUrl, parsed.entityHash)
  if (remoteContent) {
    const hit = sceneEmoteFromContent(
      urn,
      parsed,
      remoteContent,
      (hash) => catalystAssetUrl(peerUrl, hash),
      peerUrl
    )
    if (hit) return hit
  }

  return null
}

async function resolveFromCatalystUrn(
  urn: string,
  bodyShape: BodyShape,
  peerUrl: string
): Promise<ResolvedProfileEmote | null> {
  const pointer = catalystPointerForEmoteUrn(urn)
  const res = await fetch(`${peerUrl.replace(/\/$/, '')}/content/entities/active`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pointers: [pointer] })
  })
  if (!res.ok) return null

  const entities = (await res.json()) as CatalystEmoteEntity[]
  const entity = entities[0]
  const reps = entity?.metadata?.emoteDataADR74?.representations
  if (!entity || !reps?.length) return null

  const rep = pickRepresentation(reps, bodyShape)
  if (!rep) return null

  const url = emoteGlbUrl(entity, rep, peerUrl)
  if (!url) return null

  return {
    url,
    loop: !!entity.metadata.emoteDataADR74?.loop,
    urn: urn.trim().toLowerCase().startsWith('urn:') ? urn.trim().toLowerCase() : (entity.metadata.id ?? pointer),
    content: entity.content ?? [],
    peerUrl
  }
}

/** Resolve emote GLB from Catalyst (correct mainFile e.g. Money_Particles.glb with prop meshes). */
export async function resolveProfileEmote(
  emoteRef: string,
  bodyShape: BodyShape,
  peerUrl = PEER_URL,
  options?: { loop?: boolean }
): Promise<ResolvedProfileEmote | null> {
  const ref = emoteRef.trim()
  if (!ref) return null

  let wireUrn = ref.startsWith('urn:') ? ref.toLowerCase() : ''
  if (!wireUrn) {
    const scene = resolveSceneEmoteFromSrc(ref, options?.loop ?? false)
    wireUrn = scene?.urn ?? baseEmoteUrn(ref)
  }
  const cacheKey = isSceneEmoteUrn(wireUrn)
    ? `${peerUrl}|scene|${wireUrn}`
    : `${peerUrl}|${bodyShape}|${catalystPointerForEmoteUrn(wireUrn)}|${wireUrn}`
  let pending = emoteResolveCache.get(cacheKey)
  if (!pending) {
    pending = isSceneEmoteUrn(wireUrn)
      ? resolveSceneEmoteUrn(wireUrn, peerUrl)
      : resolveFromCatalystUrn(wireUrn, bodyShape, peerUrl)
    emoteResolveCache.set(cacheKey, pending)
  }
  const resolved = await pending
  if (resolved) return resolved

  const bundled = bundledEmoteUrl(ref)
  if (!bundled) return null

  const slug = baseEmoteSlugFromRef(ref) ?? normalizeEmoteId(ref)
  return { url: bundled, loop: bundledEmoteLoop(slug), urn: wireUrn, content: [], peerUrl }
}

/** Load resolved emote with content manifest so prop textures resolve. */
export async function loadResolvedProfileEmote(
  cache: AssetCache,
  resolved: ResolvedProfileEmote
): Promise<CachedGltf | null> {
  if (resolved.content.length) {
    return cache.loadEmote(resolved.url, resolved.content, resolved.peerUrl)
  }
  return cache.load(resolved.url, undefined, { emote: true, quiet: true })
}

export type LocomotionEmoteSlug = 'idle' | 'walk' | 'run' | 'jump' | 'double_jump'

/** Idle/walk/run/jump — bundled Avatar_ rig first; Catalyst only when bundled is unavailable. */
export async function loadLocomotionEmoteGltf(
  slug: LocomotionEmoteSlug,
  bodyShape: BodyShape,
  peerUrl: string,
  cache: AssetCache
): Promise<CachedGltf | null> {
  const bundled = bundledEmoteUrl(slug)
  if (bundled) {
    try {
      const gltf = await cache.load(bundled, undefined, { quiet: true })
      if (gltf?.animations[0]) return gltf
    } catch {
      /* try Catalyst */
    }
  }

  const resolved = await resolveProfileEmote(slug, bodyShape, peerUrl)
  if (resolved) {
    try {
      const gltf = await loadResolvedProfileEmote(cache, resolved)
      if (gltf?.animations[0]) return gltf
    } catch {
      return null
    }
  }

  return null
}
