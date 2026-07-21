/**
 * Detect smart wearables (portable experiences bound to equipped wearables).
 * Catalyst wearable entities ship PE under male|female/bin/index.js + scene.json
 * (e.g. DCL Neurolink N1) — not root bin/index.js like parcel scenes.
 */
import { normalizeUrn, PEER_URL } from '../../avatar/constants'
import { catalystPointerForWearableUrn } from '../../avatar/wearablePointers'
import {
  catalystContentAssetUrl,
  catalystEntitiesActiveUrl,
  catalystRootFromContentUrl
} from '../../network/catalyst/CatalystClient'
import { pickSceneSpawn } from '../content/pickSceneSpawn'
import { layoutFromSceneMetadata } from '../content/sceneLayout'
import type { ContentFile, RealmEndpoints, ResolvedScene, SceneMetadata } from '../content/types'
import { resolveBrowserChatEnabled } from '../content/resolveBrowserChat'
import { resolveNameTagsVisible } from '../content/resolveNameTags'
import { resolveSceneEnvironment } from '../landscape/resolveLandscapeEnvironment'
import { parseRequiredPermissions } from './pePermissions'
import type { PeCandidate } from './types'

type CatalystEntity = {
  id?: string
  type?: string
  content?: Array<{ file?: string; hash?: string }>
  metadata?: Record<string, unknown>
  pointers?: string[]
}

function parseContent(raw: unknown): ContentFile[] {
  if (!Array.isArray(raw)) return []
  const out: ContentFile[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.file === 'string' && typeof r.hash === 'string') {
      out.push({ file: r.file, hash: r.hash })
    }
  }
  return out
}

function contentFileLeaf(file: string): string {
  const parts = file.split('/')
  return parts[parts.length - 1] ?? file
}

/**
 * Smart wearables use male|female/bin/index.js; parcel scenes use bin/index.js.
 * Optional bodyShape prefers that representation.
 */
export function findSmartWearableMainEntry(
  content: ContentFile[],
  metadata: SceneMetadata,
  bodyShape: 'male' | 'female' = 'male'
): string | null {
  const preferred = bodyShape === 'female' ? 'female' : 'male'
  const other = preferred === 'male' ? 'female' : 'male'
  const tryPaths = [
    `${preferred}/bin/index.js`,
    `${preferred}/bin/scene.js`,
    `${other}/bin/index.js`,
    `${other}/bin/scene.js`,
    'bin/index.js',
    'bin/scene.js',
    'bin/game.js'
  ]
  // scene.json "main": "bin/index.js" is relative to male|female folder
  if (typeof metadata.main === 'string' && metadata.main.trim()) {
    const m = metadata.main.trim().replace(/^\.\//, '')
    for (const prefix of [preferred, other, '']) {
      const full = prefix ? `${prefix}/${m}` : m
      if (content.some((c) => c.file === full)) return full
    }
  }
  for (const p of tryPaths) {
    if (content.some((c) => c.file === p)) return p
  }
  const any = content.find(
    (c) =>
      /(?:^|\/)bin\/index\.js$/i.test(c.file) ||
      /(?:^|\/)bin\/scene\.js$/i.test(c.file)
  )
  return any?.file ?? null
}

/** True when entity content looks like a portable / smart-wearable scene package. */
export function entityLooksLikePortableExperience(entity: CatalystEntity): boolean {
  const content = parseContent(entity.content)
  if (!content.length) return false
  // PE script entry (root or male/female representation)
  if (content.some((c) => /(?:^|\/)bin\/index\.js$/i.test(c.file))) return true
  if (content.some((c) => /(?:^|\/)bin\/scene\.js$/i.test(c.file))) return true
  // scene.json under representation folder
  if (content.some((c) => c.file === 'scene.json' || c.file.endsWith('/scene.json'))) return true
  const meta = entity.metadata ?? {}
  if (meta.isPortableExperience === true) return true
  const data = meta.data
  if (data && typeof data === 'object' && (data as { isSmart?: boolean }).isSmart === true) {
    return true
  }
  if (typeof meta.main === 'string' && meta.main.trim()) return true
  return false
}

function titleFromEntity(entity: CatalystEntity, fallback: string): string {
  const meta = entity.metadata ?? {}
  const display = meta.display as { title?: string } | undefined
  if (typeof display?.title === 'string' && display.title.trim()) return display.title.trim()
  if (typeof meta.name === 'string' && meta.name.trim()) return meta.name.trim()
  const i18n = meta.i18n
  if (i18n && typeof i18n === 'object') {
    const en = (i18n as Record<string, unknown>).en
    if (Array.isArray(en) && typeof en[0] === 'string') return en[0]
  }
  return fallback
}

function resolveContentImageUrl(
  content: ContentFile[],
  contentUrl: string,
  names: string[]
): string | undefined {
  for (const name of names) {
    const hit =
      content.find((c) => c.file === name || c.file.endsWith(`/${name}`)) ??
      content.find(
        (c) =>
          contentFileLeaf(c.file).toLowerCase() === name.toLowerCase() ||
          contentFileLeaf(c.file).toLowerCase() === contentFileLeaf(name).toLowerCase()
      )
    if (hit) return catalystContentAssetUrl(contentUrl, hit.hash)
  }
  return undefined
}

function iconFromEntity(entity: CatalystEntity, contentUrl: string): string | undefined {
  const content = parseContent(entity.content)
  const meta = entity.metadata ?? {}
  const named =
    (typeof meta.menuBarIcon === 'string' && meta.menuBarIcon) ||
    (typeof meta.image === 'string' && meta.image) ||
    (typeof meta.thumbnail === 'string' && meta.thumbnail) ||
    ''
  const fromNamed = named
    ? resolveContentImageUrl(content, contentUrl, [named, contentFileLeaf(named)])
    : undefined
  if (fromNamed) return fromNamed
  if (typeof meta.thumbnail === 'string' && /^https?:\/\//i.test(meta.thumbnail)) {
    return meta.thumbnail
  }
  if (typeof meta.image === 'string' && /^https?:\/\//i.test(meta.image)) {
    return meta.image
  }
  return (
    resolveContentImageUrl(content, contentUrl, [
      'thumbnail.png',
      'thumbnail.jpg',
      'image.png',
      'icon.png'
    ]) ??
    (() => {
      const hit = content.find(
        (c) => /thumbnail|icon|image/i.test(c.file) && /\.(png|jpg|webp|jpeg)$/i.test(c.file)
      )
      return hit ? catalystContentAssetUrl(contentUrl, hit.hash) : undefined
    })()
  )
}

function thumbnailFromEntity(entity: CatalystEntity, contentUrl: string): string | undefined {
  const content = parseContent(entity.content)
  const meta = entity.metadata ?? {}
  const display = meta.display as { navmapThumbnail?: string; thumbnail?: string } | undefined
  const named =
    (typeof display?.navmapThumbnail === 'string' && display.navmapThumbnail) ||
    (typeof display?.thumbnail === 'string' && display.thumbnail) ||
    (typeof meta.thumbnail === 'string' && meta.thumbnail) ||
    (typeof meta.image === 'string' && meta.image) ||
    ''
  if (named) {
    if (/^https?:\/\//i.test(named)) return named
    const url = resolveContentImageUrl(content, contentUrl, [named, contentFileLeaf(named)])
    if (url) return url
  }
  return (
    resolveContentImageUrl(content, contentUrl, [
      'thumbnail.png',
      'thumbnail.jpg',
      'thumbnail.webp',
      'image.png'
    ]) ?? iconFromEntity(entity, contentUrl)
  )
}

async function loadSceneJson(
  content: ContentFile[],
  contentUrl: string,
  bodyShape: 'male' | 'female'
): Promise<Record<string, unknown> | null> {
  const preferred = bodyShape === 'female' ? 'female/scene.json' : 'male/scene.json'
  const entry =
    content.find((c) => c.file === preferred) ??
    content.find((c) => c.file === 'scene.json') ??
    content.find((c) => c.file.endsWith('/scene.json'))
  if (!entry) return null
  try {
    const res = await fetch(catalystContentAssetUrl(contentUrl, entry.hash), {
      headers: { Accept: 'application/json' }
    })
    if (!res.ok) return null
    return (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Permissions from wearable entity metadata and/or representation scene.json.
 */
async function loadRequiredPermissions(
  entity: CatalystEntity,
  content: ContentFile[],
  contentUrl: string,
  bodyShape: 'male' | 'female'
): Promise<string[]> {
  const meta = entity.metadata ?? {}
  const fromMeta = parseRequiredPermissions(meta.requiredPermissions)
  if (fromMeta.length) return fromMeta

  const sceneJson = await loadSceneJson(content, contentUrl, bodyShape)
  if (!sceneJson) return []
  return parseRequiredPermissions(sceneJson.requiredPermissions)
}

export type DiscoverPeOptions = {
  /** Prefer male|female representation (default male). */
  bodyShape?: 'male' | 'female'
}

/**
 * Fetch equipped wearable entities and return those that are portable experiences.
 */
export async function discoverEquippedPortableExperiences(
  wearables: string[],
  peerUrl = PEER_URL,
  opts?: DiscoverPeOptions
): Promise<{ candidates: PeCandidate[]; scenes: Map<string, ResolvedScene> }> {
  const candidates: PeCandidate[] = []
  const scenes = new Map<string, ResolvedScene>()
  const bodyShape = opts?.bodyShape === 'female' ? 'female' : 'male'

  if (!wearables.length) {
    console.info('[pe] discover: no wearables on profile')
    return { candidates, scenes }
  }

  const pointers = [
    ...new Set(
      wearables
        .map((u) => u.trim())
        .filter(Boolean)
        .map((u) => catalystPointerForWearableUrn(normalizeUrn(u)))
    )
  ]
  if (!pointers.length) return { candidates, scenes }

  // CRITICAL: use catalystEntitiesActiveUrl — contentUrl often already ends with /content
  // (double /content/content/entities/active → 404 and zero PEs).
  let entities: CatalystEntity[] = []
  const activeUrl = catalystEntitiesActiveUrl(peerUrl)
  try {
    const res = await fetch(activeUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ pointers })
    })
    if (!res.ok) {
      console.warn('[pe] wearable entity fetch failed', res.status, activeUrl)
      return { candidates, scenes }
    }
    entities = (await res.json()) as CatalystEntity[]
  } catch (err) {
    console.warn('[pe] wearable entity fetch error', err)
    return { candidates, scenes }
  }

  console.info(
    `[pe] discover: ${pointers.length} pointers → ${entities.length} entities @ ${activeUrl}`
  )

  const contentRoot = catalystRootFromContentUrl(peerUrl)
  const realm: RealmEndpoints = {
    realmName: 'main',
    networkId: 1,
    contentUrl: contentRoot,
    lambdasUrl: `${contentRoot}/lambdas`
  }

  for (const entity of entities) {
    if (!entityLooksLikePortableExperience(entity)) {
      const files = parseContent(entity.content)
        .map((c) => c.file)
        .slice(0, 8)
      console.info(
        `[pe] skip non-PE wearable ${entity.pointers?.[0] ?? entity.id ?? '?'} files=${files.join(',')}`
      )
      continue
    }

    const content = parseContent(entity.content)
    // Prefer PE scene.json metadata for title/main/permissions when present.
    const sceneJson = await loadSceneJson(content, contentRoot, bodyShape)
    const baseMeta = (entity.metadata ?? {}) as SceneMetadata
    const sceneMeta = (sceneJson ?? {}) as SceneMetadata
    const metadata: SceneMetadata = {
      ...baseMeta,
      ...sceneMeta,
      display: {
        ...(typeof baseMeta.display === 'object' ? baseMeta.display : {}),
        ...(typeof sceneMeta.display === 'object' ? sceneMeta.display : {})
      },
      main:
        (typeof sceneMeta.main === 'string' && sceneMeta.main) ||
        (typeof baseMeta.main === 'string' && baseMeta.main) ||
        undefined
    }

    const mainEntry = findSmartWearableMainEntry(content, metadata, bodyShape)
    if (!mainEntry) {
      console.warn(
        `[pe] PE-like entity but no main entry`,
        entity.pointers?.[0] ?? entity.id,
        content.map((c) => c.file).filter((f) => f.includes('bin') || f.endsWith('scene.json'))
      )
      continue
    }

    const metaRec = metadata as SceneMetadata & { id?: string; name?: string }
    const urn =
      (typeof metaRec.id === 'string' && metaRec.id) ||
      (typeof (entity.metadata as { id?: string } | undefined)?.id === 'string'
        ? (entity.metadata as { id: string }).id
        : '') ||
      entity.pointers?.[0] ||
      (typeof entity.id === 'string' ? entity.id : '') ||
      mainEntry
    const id = normalizeUrn(urn)
    const title =
      (typeof metadata.display?.title === 'string' && metadata.display.title.trim()) ||
      titleFromEntity(entity, id.slice(0, 24))
    const iconUrl = iconFromEntity(entity, contentRoot)
    const thumbnailUrl = thumbnailFromEntity(entity, contentRoot)
    const permissions = await loadRequiredPermissions(entity, content, contentRoot, bodyShape)

    let parcels = ['0,0']
    let base = '0,0'
    try {
      const layout = layoutFromSceneMetadata(metadata)
      if (layout.parcels.length) {
        parcels = layout.parcels
        base = layout.base
      }
    } catch {
      /* keep synthetic */
    }

    const metadataWithPerms: SceneMetadata = {
      ...metadata,
      ...(permissions.length ? { requiredPermissions: permissions } : {})
    }

    const source: ResolvedScene['source'] = { kind: 'portable', urn: id }
    const resolvedEnv = resolveSceneEnvironment(metadataWithPerms, { kind: 'blank' })
    const entityId =
      typeof entity.id === 'string' && entity.id.trim() ? entity.id.trim() : id

    const scene: ResolvedScene = {
      title,
      parcels,
      baseParcel: base,
      spawn: pickSceneSpawn(metadataWithPerms),
      metadata: metadataWithPerms,
      landscapeEnvironment: resolvedEnv.landscapeEnvironment,
      skyLighting: resolvedEnv.skyLighting,
      content,
      contentsBaseUrl: contentRoot,
      assetUrl: (hash) => catalystContentAssetUrl(contentRoot, hash),
      source,
      entityId,
      mainEntry,
      commsPointer: id,
      browserChatEnabled: resolveBrowserChatEnabled(metadataWithPerms),
      nameTagsVisible: resolveNameTagsVisible(metadataWithPerms),
      portableExperiencesPolicy: { allowed: true, uiAllowed: true, raw: 'default' },
      realm
    }

    candidates.push({
      id,
      urn: id,
      title,
      iconUrl,
      thumbnailUrl: thumbnailUrl ?? iconUrl,
      permissions
    })
    scenes.set(id, scene)
    console.info(
      `[pe] candidate “${title}” main=${mainEntry} perms=${permissions.length} entity=${entityId.slice(0, 16)}…`
    )
  }

  if (candidates.length) {
    console.info(
      `[pe] discovered ${candidates.length} smart wearable PE(s):`,
      candidates.map((c) => c.title).join(', ')
    )
  } else {
    console.info('[pe] discovered 0 smart wearable PEs (equipped may be cosmetic-only)')
  }
  return { candidates, scenes }
}
