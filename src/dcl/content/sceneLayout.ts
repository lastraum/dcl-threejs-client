import type { SceneMetadata } from './types'

/** Parcels + base from scene.json — base SW corner is scene-space origin (0,0). */
export function layoutFromSceneMetadata(metadata: SceneMetadata): { parcels: string[]; base: string } {
  const scene = metadata.scene
  const parcels = Array.isArray(scene?.parcels) ? scene.parcels.filter(Boolean) : ['0,0']
  const base = typeof scene?.base === 'string' ? scene.base : parcels[0] ?? '0,0'
  return { parcels, base }
}