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

export const DEFAULT_TERRAIN_SCULPT_SETTINGS: TerrainSculptSettings = {
  paintLayer: 'height',
  brushMode: 'raise',
  brushSizeM: 24,
  brushStrength: 0.55,
  splatChannel: 0,
  splatErase: false
}

export interface TerrainProceduralShading {
  sandAboveWaterM: number
  sandBandM: number
  sandEnabled: boolean
  rockSlopeStart: number
  rockSlopeEnd: number
}

export const DEFAULT_TERRAIN_PROCEDURAL_SHADING: TerrainProceduralShading = {
  sandAboveWaterM: 0.8,
  sandBandM: 1.5,
  sandEnabled: true,
  rockSlopeStart: 0.42,
  rockSlopeEnd: 0.62
}

export const TERRAIN_ASSET_DIR = 'assets/terrain'
export const TERRAIN_HEIGHTMAP_FILE = `${TERRAIN_ASSET_DIR}/heightmap.png`
export const TERRAIN_HEIGHTS_BIN_FILE = `${TERRAIN_ASSET_DIR}/heightmap.heights.bin`
export const TERRAIN_SPLAT_FILE = `${TERRAIN_ASSET_DIR}/splat.png`
export const TERRAIN_LAVA_FILE = `${TERRAIN_ASSET_DIR}/lava.png`
export const TERRAIN_GLB_FILE = `${TERRAIN_ASSET_DIR}/terrain.glb`