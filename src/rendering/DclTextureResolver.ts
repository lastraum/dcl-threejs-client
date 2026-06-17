import { catalystAssetUrl } from '../dcl/landscape/Data/EmptyLandCatalog'
import type { ContentFile } from '../dcl/content/types'
import { BUNDLED_EMOTE_FILES_MAP } from '../avatar/profileEmotes'

/**
 * Shared external textures referenced by DCL glTFs (from @dcl/asset-packs / creator-hub).
 * glTF embeds bare filenames; Catalyst stores them by IPFS hash.
 */
export const DCL_SHARED_TEXTURES: Record<string, string> = {
  'FanstasyPack_TX.png': 'bafkreigovfdxo4z4daxwoejgywgqvht5ueoopglgmzsjnmv7kcjjqle2cm',
  'file1.png': 'bafkreiao3j5vpvbwnod5nak5e736ldkngmmymeypxih45febzoes3k6rhi',
  'PiratesPack_TX.png': 'bafkreibtlcu5xu4u7qloyhi6s36e722qu7y7ths2xaspwqgqynpnl5aukq',
  'PiratesPack_TX.png.png': 'bafkreibtlcu5xu4u7qloyhi6s36e722qu7y7ths2xaspwqgqynpnl5aukq'
}

export function sharedTextureHashes(): string[] {
  return [...new Set(Object.values(DCL_SHARED_TEXTURES))]
}

function leafName(url: string): string {
  const clean = url.split('?')[0]!.split('#')[0]!
  const parts = clean.split('/')
  return decodeURIComponent(parts[parts.length - 1] ?? clean)
}

/** Case-insensitive manifest key — glTF embeds `Foo_Normal.png`, DCL stores `foo_normal.png`. */
function normalizeContentKey(key: string): string {
  return decodeURIComponent(key).toLowerCase()
}

const sharedTexturesByLowerKey = new Map(
  Object.entries(DCL_SHARED_TEXTURES).map(([file, hash]) => [normalizeContentKey(file), hash] as const)
)

let sceneContentByKey = new Map<string, string>()
let sceneAssetUrl: ((hash: string) => string) | null = null
let activeSceneContent: ContentFile[] = []
let activeSceneEntityId: string | null = null
let emoteContentByKey = new Map<string, string>()
let emoteAssetUrl: ((hash: string) => string) | null = null
let emoteContentDepth = 0
let wearableMappingsByKey = new Map<string, string>()
let wearableMappingsDepth = 0

export type ActiveSceneManifest = {
  content: ContentFile[]
  assetUrl: (hash: string) => string
  entityId: string | null
}

/** Active parcel scene manifest — used for scene-emote GLB resolution. */
export function getActiveSceneManifest(): ActiveSceneManifest | null {
  if (!sceneAssetUrl || activeSceneContent.length === 0) return null
  return {
    content: activeSceneContent,
    assetUrl: sceneAssetUrl,
    entityId: activeSceneEntityId
  }
}

/** Strip Blender `.001`/`.002`/… numeric suffix before extension: `Foo.001.glb` → `foo.glb`. */
function stripBlenderSuffix(name: string): string | null {
  const m = name.match(/^(.+)\.\d{3}(\.[^.]+)$/)
  return m ? m[1]! + m[2]! : null
}

/** Register the active parcel scene manifest so glTF-relative texture paths resolve to content hashes. */
export function configureSceneContent(
  content: ContentFile[],
  assetUrl: (hash: string) => string,
  entityId: string | null = null
): void {
  activeSceneContent = content
  activeSceneEntityId = entityId
  sceneContentByKey = new Map()
  for (const entry of content) {
    const leaf = leafName(entry.file)
    for (const key of [entry.file, leaf, normalizeContentKey(entry.file), normalizeContentKey(leaf)]) {
      sceneContentByKey.set(key, entry.hash)
    }
    // Bidirectional Blender suffix matching: if manifest has `Foo.001.glb`,
    // also register `foo.glb` so scene scripts referencing either name resolve.
    const strippedLeaf = stripBlenderSuffix(normalizeContentKey(leaf))
    if (strippedLeaf && !sceneContentByKey.has(strippedLeaf)) {
      sceneContentByKey.set(strippedLeaf, entry.hash)
    }
    const strippedFull = stripBlenderSuffix(normalizeContentKey(entry.file))
    if (strippedFull && !sceneContentByKey.has(strippedFull)) {
      sceneContentByKey.set(strippedFull, entry.hash)
    }
  }
  sceneAssetUrl = assetUrl
}

export function clearSceneContent(): void {
  sceneContentByKey = new Map()
  sceneAssetUrl = null
  activeSceneContent = []
  activeSceneEntityId = null
}

/** Register emote entity content so glTF-relative textures resolve during emote GLB load. */
export function pushEmoteContent(content: ContentFile[], assetUrl: (hash: string) => string): void {
  if (emoteContentDepth === 0) {
    emoteContentByKey = new Map()
    for (const entry of content) {
      const leaf = leafName(entry.file)
      for (const key of [entry.file, leaf, normalizeContentKey(entry.file), normalizeContentKey(leaf)]) {
        emoteContentByKey.set(key, entry.hash)
      }
    }
    emoteAssetUrl = assetUrl
  }
  emoteContentDepth++
}

export function popEmoteContent(): void {
  emoteContentDepth = Math.max(0, emoteContentDepth - 1)
  if (emoteContentDepth === 0) {
    emoteContentByKey = new Map()
    emoteAssetUrl = null
  }
}

/** Register wearable sidecar files so glTF-relative textures resolve during wearable GLB load. */
export function pushWearableMappings(mappings: Record<string, string>): void {
  if (wearableMappingsDepth === 0) {
    wearableMappingsByKey = new Map()
  }
  for (const [key, resolvedUrl] of Object.entries(mappings)) {
    for (const variant of wearableMappingKeyVariants(key)) {
      wearableMappingsByKey.set(variant, resolvedUrl)
    }
  }
  wearableMappingsDepth++
}

export function popWearableMappings(): void {
  wearableMappingsDepth = Math.max(0, wearableMappingsDepth - 1)
  if (wearableMappingsDepth === 0) {
    wearableMappingsByKey = new Map()
  }
}

function resolveFromWearableMappings(url: string, leaf: string): string | null {
  return resolveWearableMappingUrl(url, leaf)
}

function resolveFromEmoteManifest(url: string, leaf: string): string | null {
  if (!emoteAssetUrl) return null
  const hash =
    emoteContentByKey.get(url) ??
    emoteContentByKey.get(leaf) ??
    emoteContentByKey.get(decodeURIComponent(url)) ??
    emoteContentByKey.get(normalizeContentKey(url)) ??
    emoteContentByKey.get(normalizeContentKey(leaf))
  return hash ? emoteAssetUrl(hash) : null
}

function resolveFromSceneManifest(url: string, leaf: string): string | null {
  if (!sceneAssetUrl) return null

  const normalLeaf = normalizeContentKey(leaf)
  const hash =
    sceneContentByKey.get(url) ??
    sceneContentByKey.get(leaf) ??
    sceneContentByKey.get(decodeURIComponent(url)) ??
    sceneContentByKey.get(normalizeContentKey(url)) ??
    sceneContentByKey.get(normalLeaf) ??
    sceneContentByKey.get(stripBlenderSuffix(normalLeaf) ?? '')

  return hash ? sceneAssetUrl(hash) : null
}

function resolveSharedTexture(leaf: string): string | null {
  return DCL_SHARED_TEXTURES[leaf] ?? sharedTexturesByLowerKey.get(normalizeContentKey(leaf)) ?? null
}

/** DCL wearables often mismatch GLTF URIs (`Foo.png`) vs manifest keys (`Foo.png.png`). */
export function wearableMappingKeyVariants(key: string): string[] {
  const leaf = leafName(key)
  const variants = new Set<string>([
    key,
    leaf,
    decodeURIComponent(key),
    normalizeContentKey(key),
    normalizeContentKey(leaf)
  ])
  if (leaf.endsWith('.png.png')) {
    const single = leaf.slice(0, -4)
    variants.add(single)
    variants.add(normalizeContentKey(single))
  } else if (leaf.endsWith('.png')) {
    variants.add(`${leaf}.png`)
    variants.add(normalizeContentKey(`${leaf}.png`))
  }
  return [...variants]
}

function resolveWearableMappingUrl(url: string, leaf: string): string | null {
  for (const variant of wearableMappingKeyVariants(url)) {
    const hit = wearableMappingsByKey.get(variant)
    if (hit) return hit
  }
  for (const variant of wearableMappingKeyVariants(leaf)) {
    const hit = wearableMappingsByKey.get(variant)
    if (hit) return hit
  }
  return null
}

function isMissingHashContentUrl(url: string): boolean {
  return /decentraland\.org\/content\/contents\//i.test(url) && !/(bafy|bafkre|Qm)[a-z0-9]+/i.test(url)
}

const CONCATENATED_HASH_TEXTURE_RE =
  /\/content\/contents\/((?:bafy|bafkre|Qm)[a-z0-9]{46,})([^/?#]+\.(?:png|jpe?g|ktx2|webp|tga|bmp))/i

/** Rewrite glTF-relative texture paths to Catalyst content URLs. */
export function resolveDclAssetUrl(url: string): string {
  if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url

  const leaf = leafName(url)
  const sceneHit = resolveFromSceneManifest(url, leaf)
  if (sceneHit) return sceneHit

  const wearableHit = resolveFromWearableMappings(url, leaf)
  if (wearableHit) return wearableHit

  const emoteHit = resolveFromEmoteManifest(url, leaf)
  if (emoteHit) return emoteHit

  const shared = resolveSharedTexture(leaf)
  if (shared) return catalystAssetUrl(shared)

  // Already a catalyst hash URL
  if (/\/content\/contents\/(bafy|bafkre|Qm)[a-z0-9]+$/i.test(url.split('?')[0] ?? url)) return url

  // Wrong pattern: GLB hash + texture name concatenated (parseAsync path bug)
  const concat = url.match(CONCATENATED_HASH_TEXTURE_RE)
  if (concat?.[2]) {
    const texLeaf = leafName(concat[2])
    const retry =
      resolveFromSceneManifest(concat[2], texLeaf) ??
      resolveFromEmoteManifest(concat[2], texLeaf) ??
      (resolveSharedTexture(texLeaf) ? catalystAssetUrl(resolveSharedTexture(texLeaf)!) : null)
    if (retry) return retry
  }

  // Wrong pattern: .../contents/Filename.png (missing hash) on any catalyst host
  if (isMissingHashContentUrl(url)) {
    const retry =
      resolveFromWearableMappings(url, leaf) ??
      resolveFromSceneManifest(url, leaf) ??
      (resolveSharedTexture(leaf) ? catalystAssetUrl(resolveSharedTexture(leaf)!) : null)
    if (retry) return retry
  }

  return url
}

/** Flat URL map for off-thread GLTFLoader — mirrors active wearable/scene/emote/shared texture resolution. */
export function buildParseUrlMappings(): Record<string, string> {
  const mappings: Record<string, string> = {}

  for (const [key, url] of wearableMappingsByKey) {
    mappings[key] = url
  }

  if (sceneAssetUrl) {
    for (const entry of activeSceneContent) {
      const url = sceneAssetUrl(entry.hash)
      for (const variant of wearableMappingKeyVariants(entry.file)) mappings[variant] = url
      for (const variant of wearableMappingKeyVariants(leafName(entry.file))) mappings[variant] = url
    }
  }

  if (emoteAssetUrl) {
    for (const [key, hash] of emoteContentByKey) {
      const url = emoteAssetUrl(hash)
      for (const variant of wearableMappingKeyVariants(key)) mappings[variant] = url
    }
  }

  for (const [file, hash] of Object.entries(DCL_SHARED_TEXTURES)) {
    const url = catalystAssetUrl(hash)
    for (const variant of wearableMappingKeyVariants(file)) mappings[variant] = url
  }

  return mappings
}

const CONTENT_HASH_RE = /^(bafy|bafkre|Qm)[\w-]+$/i
const CONTENT_HASH_IN_URL_RE = /\/contents\/((?:bafy|bafkre|Qm)[^/?#]+)/i

/** Prefix for bundled emote local paths returned by resolveGltfSrcHash. */
export const GLTF_LOCAL_PREFIX = 'local://'

/** GltfContainer refs that are avatar emote rigs (sit anchors) — not visible scene meshes. */
export function isEmoteAnchorGltfSrc(ref: string): boolean {
  const trimmed = ref.trim()
  if (!trimmed) return false
  if (BUNDLED_EMOTE_FILES_MAP.has(trimmed)) return true
  const leaf = leafName(trimmed)
  const stem = leaf.replace(/\.glb$/i, '')
  if (BUNDLED_EMOTE_FILES_MAP.has(leaf) || BUNDLED_EMOTE_FILES_MAP.has(stem)) return true
  return /^sitting(chair|ground)/i.test(stem) || /^sitting(chair|ground)/i.test(trimmed)
}

/** Resolve a GltfContainer `src` to a catalyst content hash or a local:// URL for bundled emotes. */
export function resolveGltfSrcHash(content: ContentFile[], ref: string): string | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  if (CONTENT_HASH_RE.test(trimmed)) return trimmed
  const fromUrl = trimmed.match(CONTENT_HASH_IN_URL_RE)?.[1]
  if (fromUrl) return fromUrl
  const fromManifest = findSceneContentHash(content, trimmed)
  if (fromManifest) return fromManifest
  const emoteFile = BUNDLED_EMOTE_FILES_MAP.get(trimmed)
  if (emoteFile) return `${GLTF_LOCAL_PREFIX}/avatar/emotes/${emoteFile}`
  return null
}

/** Find a content hash by scene path or leaf name (case-insensitive). */
export function findSceneContentHash(content: ContentFile[], ref: string): string | null {
  const trimmed = ref.trim()
  if (!trimmed) return null
  const leaf = leafName(trimmed)
  const lower = normalizeContentKey(trimmed)
  const leafLower = normalizeContentKey(leaf)
  for (const entry of content) {
    const entryLeaf = leafName(entry.file)
    if (
      entry.file === trimmed ||
      entry.file.endsWith(`/${trimmed}`) ||
      entryLeaf === trimmed ||
      entryLeaf === leaf ||
      normalizeContentKey(entry.file) === lower ||
      normalizeContentKey(entry.file) === leafLower ||
      normalizeContentKey(entryLeaf) === lower ||
      normalizeContentKey(entryLeaf) === leafLower
    ) {
      return entry.hash
    }
  }

  // Bidirectional: if the ref itself has a .001 suffix, try the stripped version
  const strippedLower = stripBlenderSuffix(leafLower)
  if (strippedLower) {
    for (const entry of content) {
      if (normalizeContentKey(leafName(entry.file)) === strippedLower) {
        return entry.hash
      }
    }
  }

  // Reverse: if the manifest entry has a .001 suffix, try matching stripped entry to the ref
  for (const entry of content) {
    const entryLeafLower = normalizeContentKey(leafName(entry.file))
    const strippedEntry = stripBlenderSuffix(entryLeafLower)
    if (strippedEntry && (strippedEntry === leafLower || strippedEntry === lower)) {
      return entry.hash
    }
  }

  return null
}
