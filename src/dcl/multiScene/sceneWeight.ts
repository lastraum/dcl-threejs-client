/**
 * Live-secondary eligibility helpers.
 *
 * Multi-parcel deployments (any size, including CBD-scale) are allowed as live
 * secondaries. Concurrency is gated by tier cap + live radius (see caps.ts), not
 * by parcel count. Cold promote still never force-boots as secondary (World
 * seamless jump only when no live secondary).
 */

export type SceneWeightInput = {
  parcels?: readonly string[] | null
  content?: readonly { file: string }[] | null
  title?: string
  entityId?: string | null
  mainEntry?: string | null
}

export function sceneParcelCount(scene: SceneWeightInput): number {
  const n = scene.parcels?.length ?? 0
  return n > 0 ? n : 1
}

export function sceneGlbCount(scene: SceneWeightInput): number {
  if (!scene.content?.length) return 0
  let n = 0
  for (const f of scene.content) {
    if (/\.glb$/i.test(f.file)) n++
  }
  return n
}

/**
 * Eligible for live secondary worker and sticky demote.
 * No parcel-count cap — multi-parcel estates / plazas may be live secondaries.
 * (Named historically “modest”; kept for call-site stability.)
 */
export function isModestSceneForSecondary(scene: SceneWeightInput): boolean {
  // Need a real scene script to boot a worker.
  if (scene.mainEntry === null || scene.mainEntry === '') {
    // ResolvedScene always has mainEntry field; Active paths pass full ResolvedScene.
    // If caller only passes parcels/content, allow through.
    if ('mainEntry' in scene && !scene.mainEntry) return false
  }
  return true
}
