import type { ResolvedScene } from '../dcl/content/types'

export type ManifestAssetEntry = { url: string; hash: string }

export type ManifestAssetsByKind = {
  glbs: ManifestAssetEntry[]
  textures: ManifestAssetEntry[]
  audio: ManifestAssetEntry[]
}

const PREFETCH_EXTENSIONS = new Set(['glb', 'png', 'mp3'])

function extension(file: string): string {
  const dot = file.lastIndexOf('.')
  if (dot < 0) return ''
  return file.slice(dot + 1).toLowerCase()
}

/** Unique manifest entries for byte/texture/audio prefetch (by content hash). */
export function collectManifestAssets(scene: ResolvedScene): ManifestAssetsByKind {
  const glbs: ManifestAssetEntry[] = []
  const textures: ManifestAssetEntry[] = []
  const audio: ManifestAssetEntry[] = []
  const seen = new Set<string>()

  for (const entry of scene.content) {
    const ext = extension(entry.file)
    if (!PREFETCH_EXTENSIONS.has(ext)) continue
    if (!entry.hash || seen.has(entry.hash)) continue
    seen.add(entry.hash)

    const item = { url: scene.assetUrl(entry.hash), hash: entry.hash }
    if (ext === 'glb') glbs.push(item)
    else if (ext === 'png') textures.push(item)
    else if (ext === 'mp3') audio.push(item)
  }

  return { glbs, textures, audio }
}

/** @deprecated Use `collectManifestAssets(scene).glbs` */
export function collectManifestGlbs(scene: ResolvedScene): ManifestAssetEntry[] {
  return collectManifestAssets(scene).glbs
}