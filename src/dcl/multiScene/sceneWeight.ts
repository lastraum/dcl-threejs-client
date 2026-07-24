/**
 * Dual-resident multi-scene (primary + sticky/live secondary) is only safe for
 * modest footprints. CBD-scale multi-parcel plazas (dozens of parcels, 100+ GLBs)
 * kill the tab when force-booted cold as secondary while the old primary still lives.
 */

export type SceneWeightInput = {
  parcels?: readonly string[] | null
  content?: readonly { file: string }[] | null
  title?: string
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
 * Eligible for live secondary worker and/or sticky demote after promote.
 * Larger scenes use seamless primary swap (single resident) instead.
 */
export function isModestSceneForSecondary(scene: SceneWeightInput): boolean {
  return sceneParcelCount(scene) <= 8 && sceneGlbCount(scene) <= 100
}
