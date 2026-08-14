import { catalystAssetUrl } from '../dcl/landscape/Data/EmptyLandCatalog'
import type { ContentFile } from '../dcl/content/types'
import { BUNDLED_EMOTE_FILES_MAP } from '../avatar/profileEmotes'
import { safeDecodeURIComponent } from '../util/safeDecodeURIComponent'
import { isStreamingMediaUrl, proxiedTextureUrl } from './textureProxy'

/**
 * Shared external textures referenced by DCL glTFs (from @dcl/asset-packs / builder).
 * Values are either a catalyst content hash or a full https URL (builder S3 packs).
 * glTF embeds bare filenames; we rewrite them here.
 */
export const DCL_SHARED_TEXTURES: Record<string, string> = {
  'FanstasyPack_TX.png': 'bafkreigovfdxo4z4daxwoejgywgqvht5ueoopglgmzsjnmv7kcjjqle2cm',
  'file1.png': 'bafkreiao3j5vpvbwnod5nak5e736ldkngmmymeypxih45febzoes3k6rhi',
  'PiratesPack_TX.png': 'bafkreibtlcu5xu4u7qloyhi6s36e722qu7y7ths2xaspwqgqynpnl5aukq',
  'PiratesPack_TX.png.png': 'bafkreibtlcu5xu4u7qloyhi6s36e722qu7y7ths2xaspwqgqynpnl5aukq',
  // Builder Sci-Fi pack — catalyst hashes from @dcl/asset-packs/catalog.json
  // (GLB embeds bare filenames; without these, peer /contents/SciFiPack*.png 404s).
  'SciFiPack_TX.png': 'bafkreiav3zyb6vody64gtpgax5uezxw5pqusqcbnisvp6t5rmlswickogy',
  'SciFiPack_TX.png.png': 'bafkreiav3zyb6vody64gtpgax5uezxw5pqusqcbnisvp6t5rmlswickogy',
  'SciFiPackTransp_TX.png': 'bafkreiesjrl7mp4ae3s6y5xwnvpmhpjxr44sjbri2q6q73rwmem36hz3fy',
  'SciFiPackTransp_TX.png.png': 'bafkreiesjrl7mp4ae3s6y5xwnvpmhpjxr44sjbri2q6q73rwmem36hz3fy',
  'SciFiPack_UI01_TX.png': 'bafkreigm6aspqcl7nchxwojqhtfvpeuyp22xdn56r453bw4utggfzm3ypa',
  'SciFiPack_UI01_TX.png.png': 'bafkreigm6aspqcl7nchxwojqhtfvpeuyp22xdn56r453bw4utggfzm3ypa',
  'SciFiPack_UI02_Transp_TX.png': 'bafkreiejgnh722gxewn6zjfj67t5m5klqy3a7kz26vbf7el3376auxrw4i',
  'SciFiPack_UI02_Transp_TX.png.png': 'bafkreiejgnh722gxewn6zjfj67t5m5klqy3a7kz26vbf7el3376auxrw4i'
}

export function sharedTextureHashes(): string[] {
  // Only catalyst hashes — full https pack URLs are not catalyst contents.
  return [
    ...new Set(
      Object.values(DCL_SHARED_TEXTURES).filter((v) => !/^https?:\/\//i.test(v) && /^(bafy|bafkre|Qm)/i.test(v))
    )
  ]
}

function leafName(url: string): string {
  const clean = url.split('?')[0]!.split('#')[0]!
  const parts = clean.split('/')
  return safeDecodeURIComponent(parts[parts.length - 1] ?? clean)
}

/** Case-insensitive manifest key — glTF embeds `Foo_Normal.png`, DCL stores `foo_normal.png`. */
function normalizeContentKey(key: string): string {
  return safeDecodeURIComponent(key).toLowerCase()
}

const sharedTexturesByLowerKey = new Map(
  Object.entries(DCL_SHARED_TEXTURES).map(([file, hash]) => [normalizeContentKey(file), hash] as const)
)

type SceneManifestReg = {
  content: ContentFile[]
  assetUrl: (hash: string) => string
  byKey: Map<string, string>
}

const sceneManifests = new Map<string, SceneManifestReg>()
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

function buildSceneKeyMap(content: ContentFile[]): Map<string, string> {
  const byKey = new Map<string, string>()
  for (const entry of content) {
    const leaf = leafName(entry.file)
    for (const key of [entry.file, leaf, normalizeContentKey(entry.file), normalizeContentKey(leaf)]) {
      byKey.set(key, entry.hash)
    }
    const strippedLeaf = stripBlenderSuffix(normalizeContentKey(leaf))
    if (strippedLeaf && !byKey.has(strippedLeaf)) {
      byKey.set(strippedLeaf, entry.hash)
    }
    const strippedFull = stripBlenderSuffix(normalizeContentKey(entry.file))
    if (strippedFull && !byKey.has(strippedFull)) {
      byKey.set(strippedFull, entry.hash)
    }
  }
  return byKey
}

function lookupHashInMap(byKey: Map<string, string>, url: string, leaf: string): string | null {
  const normalLeaf = normalizeContentKey(leaf)
  const hash =
    byKey.get(url) ??
    byKey.get(leaf) ??
    byKey.get(safeDecodeURIComponent(url)) ??
    byKey.get(normalizeContentKey(url)) ??
    byKey.get(normalLeaf) ??
    byKey.get(stripBlenderSuffix(normalLeaf) ?? '')
  if (hash) return hash
  const suffix = `/${normalLeaf}`
  for (const [key, entryHash] of byKey) {
    if (key.endsWith(suffix) || key === normalLeaf) return entryHash
  }
  return null
}

/**
 * Register a scene manifest. Live neighbors keep their hashes after primary
 * `setScene` — otherwise plaza `CBDplaza.png` 404s and roads stay untextured.
 */
export function configureSceneContent(
  content: ContentFile[],
  assetUrl: (hash: string) => string,
  entityId: string | null = null
): void {
  const id = entityId?.trim() || '__primary__'
  const byKey = buildSceneKeyMap(content)
  sceneManifests.set(id, { content, assetUrl, byKey })
  activeSceneContent = content
  activeSceneEntityId = entityId
  sceneContentByKey = byKey
  sceneAssetUrl = assetUrl
}

export function unregisterSceneContent(entityId: string): void {
  const id = entityId.trim()
  if (!id) return
  sceneManifests.delete(id)
  if (activeSceneEntityId === id) {
    activeSceneEntityId = null
  }
}

export function clearSceneContent(): void {
  sceneManifests.clear()
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
      // Same key variants as wearables — Catalyst often mismatches `Foo.png` vs `Foo.png.png`.
      for (const key of wearableMappingKeyVariants(entry.file)) {
        emoteContentByKey.set(key, entry.hash)
      }
      for (const key of wearableMappingKeyVariants(leaf)) {
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
  for (const variant of wearableMappingKeyVariants(url)) {
    const hash = emoteContentByKey.get(variant)
    if (hash) return emoteAssetUrl(hash)
  }
  for (const variant of wearableMappingKeyVariants(leaf)) {
    const hash = emoteContentByKey.get(variant)
    if (hash) return emoteAssetUrl(hash)
  }
  return null
}

function resolveFromSceneManifest(url: string, leaf: string): string | null {
  const activeId = activeSceneEntityId?.trim() || '__primary__'
  const active = sceneManifests.get(activeId)
  if (active) {
    const hash = lookupHashInMap(active.byKey, url, leaf)
    if (hash) return active.assetUrl(hash)
  } else if (sceneAssetUrl) {
    const hash = lookupHashInMap(sceneContentByKey, url, leaf)
    if (hash) return sceneAssetUrl(hash)
  }
  for (const [id, reg] of sceneManifests) {
    if (id === activeId) continue
    const hash = lookupHashInMap(reg.byKey, url, leaf)
    if (hash) return reg.assetUrl(hash)
  }
  return null
}

/** Shared pack entry as catalyst hash or absolute URL. */
function resolveSharedTexture(leaf: string): string | null {
  return DCL_SHARED_TEXTURES[leaf] ?? sharedTexturesByLowerKey.get(normalizeContentKey(leaf)) ?? null
}

/** Resolve shared pack leaf → fetchable URL (hash → catalyst, or passthrough https). */
function sharedTextureUrl(leaf: string): string | null {
  const entry = resolveSharedTexture(leaf)
  if (!entry) return null
  if (/^https?:\/\//i.test(entry)) return entry
  return catalystAssetUrl(entry)
}

/** DCL wearables often mismatch GLTF URIs (`Foo.png`) vs manifest keys (`Foo.png.png`). */
export function wearableMappingKeyVariants(key: string): string[] {
  const leaf = leafName(key)
  const variants = new Set<string>([
    key,
    leaf,
    safeDecodeURIComponent(key),
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

function resolveKnownAssetUrl(url: string, leaf: string): string | null {
  return (
    resolveFromSceneManifest(url, leaf) ??
    resolveFromWearableMappings(url, leaf) ??
    resolveFromEmoteManifest(url, leaf) ??
    sharedTextureUrl(leaf)
  )
}

/** Rewrite glTF-relative texture paths to Catalyst content URLs. */
export function resolveDclAssetUrl(url: string): string {
  if (!url || url.startsWith('data:')) return url

  const leaf = leafName(url)

  if (url.startsWith('blob:')) {
    const hit = resolveKnownAssetUrl(url, leaf)
    return hit ?? url
  }

  const sceneHit = resolveFromSceneManifest(url, leaf)
  if (sceneHit) return sceneHit

  const wearableHit = resolveFromWearableMappings(url, leaf)
  if (wearableHit) return wearableHit

  const emoteHit = resolveFromEmoteManifest(url, leaf)
  if (emoteHit) return emoteHit

  const sharedUrl = sharedTextureUrl(leaf)
  if (sharedUrl) return sharedUrl

  // Already a catalyst hash URL
  if (/\/content\/contents\/(bafy|bafkre|Qm)[a-z0-9]+$/i.test(url.split('?')[0] ?? url)) return url

  // Wrong pattern: GLB hash + texture name concatenated (parseAsync path bug)
  const concat = url.match(CONCATENATED_HASH_TEXTURE_RE)
  if (concat?.[2]) {
    const texLeaf = leafName(concat[2])
    const retry =
      resolveFromSceneManifest(concat[2], texLeaf) ??
      resolveFromEmoteManifest(concat[2], texLeaf) ??
      sharedTextureUrl(texLeaf)
    if (retry) return retry
  }

  // Wrong pattern: .../contents/Filename.png (missing hash) on any catalyst host
  if (isMissingHashContentUrl(url)) {
    const retry =
      resolveFromWearableMappings(url, leaf) ??
      resolveFromSceneManifest(url, leaf) ??
      sharedTextureUrl(leaf)
    if (retry) return retry
  }

  if (/^https?:/i.test(url)) {
    return isStreamingMediaUrl(url) ? url : proxiedTextureUrl(url)
  }
  return url
}

/** Flat URL map for off-thread GLTFLoader — mirrors active wearable/scene/emote/shared texture resolution. */
export function buildParseUrlMappings(): Record<string, string> {
  const mappings: Record<string, string> = {}

  for (const [key, url] of wearableMappingsByKey) {
    mappings[key] = url
  }

  const emitScene = (content: ContentFile[], assetUrl: (hash: string) => string): void => {
    for (const entry of content) {
      const url = assetUrl(entry.hash)
      for (const variant of wearableMappingKeyVariants(entry.file)) mappings[variant] = url
      for (const variant of wearableMappingKeyVariants(leafName(entry.file))) mappings[variant] = url
    }
  }
  if (sceneManifests.size > 0) {
    for (const reg of sceneManifests.values()) emitScene(reg.content, reg.assetUrl)
  } else if (sceneAssetUrl) {
    emitScene(activeSceneContent, sceneAssetUrl)
  }

  if (emoteAssetUrl) {
    for (const [key, hash] of emoteContentByKey) {
      const url = emoteAssetUrl(hash)
      for (const variant of wearableMappingKeyVariants(key)) mappings[variant] = url
    }
  }

  for (const [file, entry] of Object.entries(DCL_SHARED_TEXTURES)) {
    const url = /^https?:\/\//i.test(entry) ? entry : catalystAssetUrl(entry)
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
  if (/_emote\.glb$/i.test(leaf)) return true
  if (/\/anims\//i.test(trimmed) || /\/anims\//i.test(leaf)) return true
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
  // Trailing path segments: "assets/models/pool/beggar_rod.glb" ↔ "models/pool/beggar_rod.glb"
  const pathSuffixes: string[] = [lower]
  {
    const parts = lower.split('/').filter(Boolean)
    for (let i = 1; i < parts.length; i++) {
      pathSuffixes.push(parts.slice(i).join('/'))
    }
  }
  for (const entry of content) {
    const entryLeaf = leafName(entry.file)
    const entryLower = normalizeContentKey(entry.file)
    const entryLeafLower = normalizeContentKey(entryLeaf)
    if (
      entry.file === trimmed ||
      entry.file.endsWith(`/${trimmed}`) ||
      entryLeaf === trimmed ||
      entryLeaf === leaf ||
      entryLower === lower ||
      entryLower === leafLower ||
      entryLeafLower === lower ||
      entryLeafLower === leafLower
    ) {
      return entry.hash
    }
    // Suffix match either direction (scene scripts often omit leading folders).
    for (const suffix of pathSuffixes) {
      if (!suffix) continue
      if (entryLower === suffix || entryLower.endsWith(`/${suffix}`)) return entry.hash
      if (suffix.endsWith(`/${entryLower}`) || suffix === entryLower) return entry.hash
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
