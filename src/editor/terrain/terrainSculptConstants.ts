/** Ported from genesis-games `packages/shared/src/terrainSculpt.ts`. */

export const GENESIS_HEIGHTMAP_MAX_METERS = 120
export const TERRAIN_SCULPT_DEFAULT_RESOLUTION = 1024
export const TERRAIN_SEA_FLOOR_WORLD_Y = 0
export const ARENA_TERRAIN_HEIGHT_OFFSET = 0
export const ARENA_WATER_SURFACE_Y = 5

export type TerrainBrushMode = 'raise' | 'lower' | 'smooth' | 'flatten' | 'towater'
export type TerrainPaintLayer = 'height' | 'splat'
export type TerrainSplatChannel = 0 | 1 | 2 | 3 | 4

export const TERRAIN_SPLAT_CHANNEL_LABELS = ['Grass', 'Dirt', 'Rock', 'Sand', 'Lava'] as const

export const TERRAIN_BIOME_COLORS = {
  grass: 0x5a9e4a,
  dirt: 0x8b6914,
  rock: 0x8a8a8a,
  sand: 0xd4b878,
  lava: 0xe85a0a
} as const

export const TERRAIN_SPLAT_PAINT_UI_ORDER: readonly TerrainSplatChannel[] = [3, 0, 1, 2, 4]

export interface TerrainSculptSettings {
  paintLayer: TerrainPaintLayer
  brushMode: TerrainBrushMode
  brushSizeM: number
  brushStrength: number
  splatChannel: TerrainSplatChannel
  splatErase: boolean
}

export const TERRAIN_BRUSH_RADIUS_MIN_M = 1
export const TERRAIN_BRUSH_RADIUS_MAX_M = 50

export const DEFAULT_TERRAIN_SCULPT_SETTINGS: TerrainSculptSettings = {
  paintLayer: 'height',
  brushMode: 'raise',
  brushSizeM: 8,
  brushStrength: 0.55,
  splatChannel: 0,
  splatErase: false
}

export interface TerrainProceduralShading {
  sandEnabled: boolean
  /** World Y where sand weight begins to rise. */
  sandFromY: number
  /** World Y where sand weight peaks before fading toward grass. */
  sandToY: number
  /** Vertical blend width (m) for sand transitions. */
  sandBlendM: number
  /** World Y where grass dominates. */
  grassFromY: number
  /** World Y where grass fades at high elevation. */
  grassToY: number
  /** Vertical blend width (m) for grass transitions. */
  grassBlendM: number
  /** Slope 0–1 where rock begins. */
  rockSlopeFrom: number
  /** Slope 0–1 where rock is fully blended. */
  rockSlopeTo: number
  /** Slope blend width (0–1) for rock transitions. */
  rockBlend: number
}

export const DEFAULT_TERRAIN_PROCEDURAL_SHADING: TerrainProceduralShading = {
  sandEnabled: true,
  sandFromY: TERRAIN_SEA_FLOOR_WORLD_Y,
  sandToY: ARENA_WATER_SURFACE_Y + 1.3,
  sandBlendM: 1.5,
  grassFromY: ARENA_WATER_SURFACE_Y + 0.5,
  grassToY: GENESIS_HEIGHTMAP_MAX_METERS,
  grassBlendM: 2,
  rockSlopeFrom: 0.42,
  rockSlopeTo: 0.62,
  rockBlend: 0.12
}

export const TERRAIN_ASSET_DIR = 'assets/terrain'
export const TERRAIN_HEIGHTMAP_FILE = `${TERRAIN_ASSET_DIR}/heightmap.png`
export const TERRAIN_HEIGHTS_BIN_FILE = `${TERRAIN_ASSET_DIR}/heightmap.heights.bin`
export const TERRAIN_SPLAT_FILE = `${TERRAIN_ASSET_DIR}/splat.png`
export const TERRAIN_LAVA_FILE = `${TERRAIN_ASSET_DIR}/lava.png`
export const TERRAIN_GLB_FILE = `${TERRAIN_ASSET_DIR}/terrain.glb`

/** Baked albedo resolution embedded in terrain.glb (sculpt grid stays 1024²). */
export const TERRAIN_ALBEDO_EXPORT_RESOLUTION = 512

/** Per-parcel plane segments written to terrain.glb (sculpt grid stays 1024²). */
export const TERRAIN_EXPORT_SEGMENTS_MIN = 16
export const TERRAIN_EXPORT_SEGMENTS_MAX = 256
export const DEFAULT_TERRAIN_EXPORT_SEGMENTS = 64
export const TERRAIN_EXPORT_SEGMENT_PRESETS = [32, 64, 96, 128] as const

export interface TerrainExportSettings {
  /** Segments per 16×16 m parcel in terrain.glb (visible mesh + CL_PHYSICS). */
  exportSegmentsPerParcel: number
}

export const DEFAULT_TERRAIN_EXPORT_SETTINGS: TerrainExportSettings = {
  exportSegmentsPerParcel: DEFAULT_TERRAIN_EXPORT_SEGMENTS
}

export function clampTerrainExportSegments(value: number): number {
  return Math.max(
    TERRAIN_EXPORT_SEGMENTS_MIN,
    Math.min(TERRAIN_EXPORT_SEGMENTS_MAX, Math.round(value))
  )
}