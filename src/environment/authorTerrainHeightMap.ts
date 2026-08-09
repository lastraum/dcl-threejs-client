import * as THREE from 'three'
import type { ContentFile, ResolvedScene } from '../dcl/content/types'
import { sceneHasAuthorTerrain } from '../dcl/content/sceneAuthorTerrain'
import { sceneWorldBounds } from '../player/SceneBounds'
import { decodeHeightsBin } from '../editor/terrain/heightmapHeightsBin'
import {
  TERRAIN_GRASS_MANIFEST_FILE,
  TERRAIN_GRASS_MANIFEST_VERSION,
  TERRAIN_HEIGHTS_BIN_FILE,
  type TerrainGrassManifest
} from '../editor/terrain/terrainSculptConstants'

/**
 * GPU heightfield for ocean shore damp / foam — sourced from editor
 * `assets/terrain/heightmap.heights.bin` (same grid as grass/sculpt).
 *
 * Coordinates are DCL scene metres (SW origin = base parcel). Sample UV:
 *   u = (dclX - originX) / widthM
 *   v = (dclZ - originZ) / depthM
 * Three world XZ → DCL via (-x, z).
 */
export type AuthorTerrainHeightMap = {
  texture: THREE.DataTexture
  /** DCL metres — SW corner of scene footprint. */
  originX: number
  originZ: number
  widthM: number
  depthM: number
  resolution: number
  dispose: () => void
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

async function loadGrassManifest(scene: ResolvedScene): Promise<TerrainGrassManifest | null> {
  const entry = findContent(scene, TERRAIN_GRASS_MANIFEST_FILE)
  if (!entry) return null
  try {
    const res = await fetch(scene.assetUrl(entry.hash))
    if (!res.ok) return null
    const raw = (await res.json()) as Partial<TerrainGrassManifest>
    if (raw.client !== 'threejsclient') return null
    if (typeof raw.version === 'number' && raw.version > TERRAIN_GRASS_MANIFEST_VERSION) {
      console.warn(
        `[ocean] grass.json version ${raw.version} newer than supported ${TERRAIN_GRASS_MANIFEST_VERSION}`
      )
    }
    return raw as TerrainGrassManifest
  } catch {
    return null
  }
}

/** Build an R32F DataTexture from world-Y heights (row-major, Z then X). */
export function createAuthorTerrainHeightTexture(
  heights: Float32Array,
  resolution: number
): THREE.DataTexture {
  if (heights.length !== resolution * resolution) {
    throw new Error(
      `createAuthorTerrainHeightTexture: expected ${resolution * resolution} floats, got ${heights.length}`
    )
  }
  // RGBA float keeps WebGL2 samplers simple (height in .r). FFT ocean already requires WebGL2.
  const rgba = new Float32Array(resolution * resolution * 4)
  for (let i = 0; i < heights.length; i++) {
    const o = i * 4
    rgba[o] = heights[i]!
    rgba[o + 1] = 0
    rgba[o + 2] = 0
    rgba[o + 3] = 1
  }
  const tex = new THREE.DataTexture(rgba, resolution, resolution, THREE.RGBAFormat, THREE.FloatType)
  tex.wrapS = THREE.ClampToEdgeWrapping
  tex.wrapT = THREE.ClampToEdgeWrapping
  tex.minFilter = THREE.LinearFilter
  tex.magFilter = THREE.LinearFilter
  tex.generateMipmaps = false
  tex.flipY = false
  tex.needsUpdate = true
  return tex
}

/**
 * Load author terrain heights for ocean coupling.
 * Unlike grass buffers, this does **not** require density/grass.png — only heights.bin.
 */
export async function loadAuthorTerrainHeightMap(
  scene: ResolvedScene
): Promise<AuthorTerrainHeightMap | null> {
  if (!sceneHasAuthorTerrain(scene)) return null

  const bounds = sceneWorldBounds(scene.parcels, scene.baseParcel)
  const originX = bounds.minX
  const originZ = bounds.minZ
  const widthM = bounds.maxX - bounds.minX
  const depthM = bounds.maxZ - bounds.minZ
  if (widthM <= 0 || depthM <= 0) return null

  const manifest = await loadGrassManifest(scene)
  const heightsPath = manifest?.files?.heights ?? TERRAIN_HEIGHTS_BIN_FILE
  const heightsEntry = findContent(scene, heightsPath)
  if (!heightsEntry) {
    // Heights optional on very old projects — nothing to couple.
    return null
  }

  const buf = await fetchBytes(scene.assetUrl(heightsEntry.hash))
  if (!buf) return null
  const decoded = decodeHeightsBin(buf)
  if (!decoded) {
    console.warn('[ocean] author heightmap.heights.bin failed to decode')
    return null
  }

  const { resolution, heights } = decoded
  if (
    typeof manifest?.resolution === 'number' &&
    manifest.resolution > 1 &&
    manifest.resolution !== resolution
  ) {
    console.warn(
      `[ocean] heights res=${resolution} vs grass.json res=${manifest.resolution} — using heights.bin`
    )
  }

  const texture = createAuthorTerrainHeightTexture(heights, resolution)
  console.info(
    `[ocean] author terrain height map res=${resolution} footprint=${widthM.toFixed(0)}×${depthM.toFixed(0)}m`
  )

  return {
    texture,
    originX,
    originZ,
    widthM,
    depthM,
    resolution,
    dispose: () => {
      texture.dispose()
    }
  }
}
