import type { WearableDefinition } from './types'
import { bundledWearableSlug } from './wearablePointers'

type BundledWearableManifest = {
  id: string
  data: WearableDefinition['data']
}

const manifestCache = new Map<string, Promise<BundledWearableManifest | null>>()
const syncManifests = new Map<string, BundledWearableManifest>()

function manifestUrl(slug: string): string {
  return `/avatar/wearables/${slug}/manifest.json`
}

async function loadManifest(slug: string): Promise<BundledWearableManifest | null> {
  let pending = manifestCache.get(slug)
  if (pending === undefined) {
    pending = (async () => {
      try {
        const res = await fetch(manifestUrl(slug))
        if (!res.ok) return null
        return (await res.json()) as BundledWearableManifest
      } catch {
        return null
      }
    })()
    manifestCache.set(slug, pending)
  }
  return pending
}

function localContentUrl(slug: string, fileName: string): string {
  return `/avatar/wearables/${slug}/${encodeURIComponent(fileName)}`
}

function manifestToDefinition(manifest: BundledWearableManifest): WearableDefinition {
  const slug = bundledWearableSlug(manifest.id)
  return {
    id: manifest.id,
    data: {
      ...manifest.data,
      representations: manifest.data.representations.map((rep) => ({
        ...rep,
        contents: rep.contents.map((entry) => ({
          key: entry.key,
          url: localContentUrl(slug, entry.key)
        }))
      }))
    }
  }
}

export function tryBundledWearableDefinition(pointerUrn: string): WearableDefinition | null {
  const slug = bundledWearableSlug(pointerUrn)
  const manifest = syncManifests.get(slug)
  if (!manifest) return null
  return manifestToDefinition(manifest)
}

/** Rewrite Catalyst CDN URLs to bundled local paths when manifest exists. */
export function applyBundledWearableUrls(wearable: WearableDefinition): WearableDefinition {
  const slug = bundledWearableSlug(wearable.id)
  const manifest = syncManifests.get(slug)
  if (!manifest) return wearable
  return manifestToDefinition({ ...manifest, id: wearable.id })
}

/** Load bundled wearable manifests shipped under `public/avatar/wearables/`. */
export async function preloadBundledWearableManifests(pointers: string[]): Promise<void> {
  const slugs = [...new Set(pointers.map((pointer) => bundledWearableSlug(pointer)))]
  await Promise.all(
    slugs.map(async (slug) => {
      if (syncManifests.has(slug)) return
      const manifest = await loadManifest(slug)
      if (manifest) syncManifests.set(slug, manifest)
    })
  )
}
