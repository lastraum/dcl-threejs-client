import type { SceneMetadata, SceneSpawn } from './types'

/** One axis from scene.json — scalar or [min, max] for a random value in range. */
export function pickSpawnCoord(value: number | number[] | undefined, fallback: number): number {
  if (value === undefined || value === null) return fallback
  if (Array.isArray(value)) {
    const min = value[0] ?? fallback
    const max = value[1] ?? min
    return min + Math.random() * (max - min)
  }
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

/** Pick a random spawn point from scene.json (position ranges honored per axis). */
export function pickSceneSpawn(metadata: SceneMetadata): SceneSpawn {
  const points = metadata.spawnPoints
  if (!Array.isArray(points) || points.length === 0) {
    return { x: 0, y: 0, z: 0, fromSpawnPoints: false }
  }

  const chosen = points[Math.floor(Math.random() * points.length)]!
  const pos = chosen.position
  const cameraTarget = chosen.cameraTarget

  return {
    x: pickSpawnCoord(pos?.x, 0),
    y: pickSpawnCoord(pos?.y, 0),
    z: pickSpawnCoord(pos?.z, 0),
    cameraTarget: cameraTarget
      ? { x: cameraTarget.x, y: cameraTarget.y, z: cameraTarget.z }
      : undefined,
    fromSpawnPoints: true,
    spawnPointName: chosen.name
  }
}