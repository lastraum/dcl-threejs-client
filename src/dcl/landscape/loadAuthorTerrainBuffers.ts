import type { ContentFile, ResolvedScene } from '../content/types'
import { sceneWorldBounds } from '../../player/SceneBounds'
import { decodeHeightsBin } from '../../editor/terrain/heightmapHeightsBin'
import {
  TERRAIN_GRASS_COLOR_FILE,
  TERRAIN_GRASS_FILE,
  TERRAIN_GRASS_MANIFEST_FILE,
  TERRAIN_GRASS_MANIFEST_VERSION,
  TERRAIN_HEIGHTS_BIN_FILE,
  TERRAIN_SCULPT_DEFAULT_RESOLUTION,
  type TerrainGrassManifest
} from '../../editor/terrain/terrainSculptConstants'
import { SCENE_AUTHOR_TERRAIN_GLB } from '../content/sceneAuthorTerrain'

export type AuthorTerrainBuffers = {
  heights: Float32Array
  /** ez-tree blade density 0–255 (from grass.png). */
  grass: Uint8Array
  /** Packed RGB plant colors res²×3 (from grass-color.png), optional. */
  grassRgb: Uint8Array
  resolution: number
  originX: number
  originZ: number
  widthM: number
  depthM: number
}

function findContent(scene: ResolvedScene, relativePath: string): ContentFile | null {
  const target = relativePath.replace(/\\/g, '/').toLowerCase()
  for (const entry of scene.content) {
    const file = entry.file.replace(/\\/g, '/').toLowerCase()
    if (file === target || file.endsWith(`/${target}`)) return entry
  }
  return null
}

async function fetchBytes(url: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    return await res.arrayBuffer()
  } catch {
    return null
  }
}

async function loadPngImageData(url: string, resolution: number): Promise<ImageData | null> {
  try {
    const res = await fetch(url)
    if (!res.ok) return null
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    try {
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const el = new Image()
        el.onload = () => resolve(el)
        el.onerror = reject
        el.src = objUrl
      })
      const canvas = document.createElement('canvas')
      canvas.width = resolution
      canvas.height = resolution
      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      ctx.drawImage(img, 0, 0, resolution, resolution)
      return ctx.getImageData(0, 0, resolution, resolution)
    } finally {
      URL.revokeObjectURL(objUrl)
    }
  } catch {
    return null
  }
}

/** True when scene ships editor terrain.glb (any environment kind). */
export function sceneHasAuthorTerrainContent(scene: ResolvedScene): boolean {
  return findContent(scene, SCENE_AUTHOR_TERRAIN_GLB) != null
}

async function loadGrassManifest(scene: ResolvedScene): Promise<TerrainGrassManifest | null> {
  const entry = findContent(scene, TERRAIN_GRASS_MANIFEST_FILE)
  if (!entry) return null
  try {
    const res = await fetch(scene.assetUrl(entry.hash))
    if (!res.ok) return null
    const raw = (await res.json()) as Partial<TerrainGrassManifest>
    if (raw.client !== 'threejsclient') {
      console.warn('[ezGrass] grass.json client is not threejsclient — skipping field')
      return null
    }
    if (typeof raw.version === 'number' && raw.version > TERRAIN_GRASS_MANIFEST_VERSION) {
      console.warn(
        `[ezGrass] grass.json version ${raw.version} newer than supported ${TERRAIN_GRASS_MANIFEST_VERSION}`
      )
    }
    return raw as TerrainGrassManifest
  } catch {
    return null
  }
}

/**
 * Load ThreejsClient-only grass sidecars (grass.json + density/color/heights).
 * Not used by Unity/Godot Explorer.
 */
export async function loadAuthorTerrainBuffers(
  scene: ResolvedScene
): Promise<AuthorTerrainBuffers | null> {
  if (!sceneHasAuthorTerrainContent(scene)) return null

  const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)
  const originX = bounds.minX
  const originZ = bounds.minZ
  const widthM = bounds.maxX - bounds.minX
  const depthM = bounds.maxZ - bounds.minZ
  if (widthM <= 0 || depthM <= 0) return null

  const manifest = await loadGrassManifest(scene)
  // Prefer paths from manifest when present; fall back to fixed asset names.
  const densityPath = manifest?.files?.density ?? TERRAIN_GRASS_FILE
  const colorPath = manifest?.files?.color ?? TERRAIN_GRASS_COLOR_FILE
  const heightsPath = manifest?.files?.heights ?? TERRAIN_HEIGHTS_BIN_FILE

  const heightsEntry = findContent(scene, heightsPath)
  const grassEntry = findContent(scene, densityPath)
  const colorEntry = findContent(scene, colorPath)

  // Need at least density (or legacy grass.png) to plant anything.
  if (!grassEntry && !manifest) {
    // No grass field authored for this scene.
    if (!findContent(scene, TERRAIN_GRASS_FILE)) return null
  }

  let heights: Float32Array | null = null
  let resolution =
    typeof manifest?.resolution === 'number' && manifest.resolution > 1
      ? manifest.resolution
      : TERRAIN_SCULPT_DEFAULT_RESOLUTION

  if (heightsEntry) {
    const buf = await fetchBytes(scene.assetUrl(heightsEntry.hash))
    if (buf) {
      const decoded = decodeHeightsBin(buf)
      if (decoded) {
        heights = decoded.heights
        resolution = decoded.resolution
      }
    }
  }

  let grass: Uint8Array | null = null
  const densityEntry = grassEntry ?? findContent(scene, TERRAIN_GRASS_FILE)
  if (densityEntry) {
    const img = await loadPngImageData(scene.assetUrl(densityEntry.hash), resolution)
    if (img) {
      grass = new Uint8Array(resolution * resolution)
      for (let i = 0; i < grass.length; i++) grass[i] = img.data[i * 4]!
    }
  }

  let grassRgb = new Uint8Array(resolution * resolution * 3)
  const rgbEntry = colorEntry ?? findContent(scene, TERRAIN_GRASS_COLOR_FILE)
  if (rgbEntry) {
    const img = await loadPngImageData(scene.assetUrl(rgbEntry.hash), resolution)
    if (img) {
      for (let i = 0; i < resolution * resolution; i++) {
        const o = i * 4
        const c = i * 3
        grassRgb[c] = img.data[o]!
        grassRgb[c + 1] = img.data[o + 1]!
        grassRgb[c + 2] = img.data[o + 2]!
      }
    }
  }

  if (!heights) heights = new Float32Array(resolution * resolution)
  if (!grass) grass = new Uint8Array(resolution * resolution)

  let any = false
  for (let i = 0; i < grass.length; i++) {
    if (grass[i]! > 0) {
      any = true
      break
    }
  }
  if (!any) return null

  if (manifest) {
    console.info(
      `[ezGrass] loaded ThreejsClient field v${manifest.version} res=${resolution} format=${manifest.format}`
    )
  }

  return {
    heights,
    grass,
    grassRgb,
    resolution,
    originX,
    originZ,
    widthM,
    depthM
  }
}
