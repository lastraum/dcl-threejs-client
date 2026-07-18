/** Ported from genesis-games `packages/shared/src/terrainSculpt.ts`. */

export const GENESIS_HEIGHTMAP_MAX_METERS = 120
export const TERRAIN_SCULPT_DEFAULT_RESOLUTION = 1024
export const TERRAIN_SEA_FLOOR_WORLD_Y = 0
export const ARENA_TERRAIN_HEIGHT_OFFSET = 0
export const ARENA_WATER_SURFACE_Y = 5

export type TerrainBrushMode = 'raise' | 'lower' | 'smooth' | 'flatten' | 'towater'
/** height = sculpt · splat = surface material · grass = plant ez-tree blade GLBs */
export type TerrainPaintLayer = 'height' | 'splat' | 'grass'
export type TerrainSplatChannel = 0 | 1 | 2 | 3 | 4

/**
 * Splat albedo channels for the heightmap surface (Paint tab).
 * Channel 0 “Grass” = green material color — separate from the Grass tab (ez-tree blade GLBs).
 */
export const TERRAIN_SPLAT_CHANNEL_LABELS = ['Grass', 'Dirt', 'Rock', 'Sand', 'Lava'] as const

export const TERRAIN_BIOME_COLORS = {
  grass: 0x5a9e4a,
  dirt: 0x8b6914,
  rock: 0x8a8a8a,
  sand: 0xd4b878,
  lava: 0xe85a0a,
  water: 0x000a14
} as const

export function terrainColorToHex(color: number): string {
  return `#${(color & 0xffffff).toString(16).padStart(6, '0')}`
}

export function terrainColorFromHex(hex: string): number {
  const parsed = Number.parseInt(hex.replace(/^#/, ''), 16)
  return Number.isFinite(parsed) ? parsed & 0xffffff : 0
}

export const TERRAIN_SPLAT_PAINT_UI_ORDER: readonly TerrainSplatChannel[] = [3, 0, 1, 2, 4]

export interface TerrainSculptSettings {
  paintLayer: TerrainPaintLayer
  brushMode: TerrainBrushMode
  brushSizeM: number
  brushStrength: number
  splatChannel: TerrainSplatChannel
  splatErase: boolean
  /** Active Ez Grass plant color (0xRRGGBB) — written into grass-color.png per cell. */
  grassColor: number
}

export const TERRAIN_BRUSH_RADIUS_MIN_M = 1
export const TERRAIN_BRUSH_RADIUS_MAX_M = 50

/** Default ez-tree blade plant color (matches landscape grass tint). */
export const DEFAULT_EZ_GRASS_COLOR = 0xd44831

export const DEFAULT_TERRAIN_SCULPT_SETTINGS: TerrainSculptSettings = {
  paintLayer: 'height',
  brushMode: 'raise',
  brushSizeM: 8,
  brushStrength: 0.55,
  splatChannel: 0,
  splatErase: false,
  grassColor: DEFAULT_EZ_GRASS_COLOR
}

export interface TerrainProceduralShading {
  sandColor: number
  grassColor: number
  rockColor: number
  waterColor: number
  /** World Y where submerged water weight begins. */
  waterFromY: number
  /** World Y of the water surface (“to water” sculpt target). */
  waterToY: number
  /** Vertical blend width (m) for water transitions. */
  waterBlendM: number
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
  /** World Y where rock begins to replace grass. */
  rockFromY: number
  /** World Y where rock weight peaks before fading. */
  rockToY: number
  /** Vertical blend width (m) for rock transitions. */
  rockBlendM: number
}

export const DEFAULT_TERRAIN_PROCEDURAL_SHADING: TerrainProceduralShading = {
  sandColor: TERRAIN_BIOME_COLORS.sand,
  grassColor: TERRAIN_BIOME_COLORS.grass,
  rockColor: TERRAIN_BIOME_COLORS.rock,
  waterColor: TERRAIN_BIOME_COLORS.water,
  waterFromY: TERRAIN_SEA_FLOOR_WORLD_Y,
  waterToY: ARENA_WATER_SURFACE_Y,
  waterBlendM: 1.5,
  sandFromY: TERRAIN_SEA_FLOOR_WORLD_Y,
  sandToY: ARENA_WATER_SURFACE_Y + 1.3,
  sandBlendM: 1.5,
  grassFromY: ARENA_WATER_SURFACE_Y + 0.5,
  grassToY: GENESIS_HEIGHTMAP_MAX_METERS,
  grassBlendM: 2,
  rockFromY: 40,
  rockToY: GENESIS_HEIGHTMAP_MAX_METERS,
  rockBlendM: 2
}

export const TERRAIN_ASSET_DIR = 'assets/terrain'
export const TERRAIN_HEIGHTMAP_FILE = `${TERRAIN_ASSET_DIR}/heightmap.png`
export const TERRAIN_HEIGHTS_BIN_FILE = `${TERRAIN_ASSET_DIR}/heightmap.heights.bin`
export const TERRAIN_SPLAT_FILE = `${TERRAIN_ASSET_DIR}/splat.png`
export const TERRAIN_LAVA_FILE = `${TERRAIN_ASSET_DIR}/lava.png`
/** Density map for ez-tree grass blade GLBs (R channel 0–255). Not albedo splat. */
export const TERRAIN_GRASS_FILE = `${TERRAIN_ASSET_DIR}/grass.png`
/** Per-cell plant RGB for multi-tint ez-tree blades (RGB PNG). */
export const TERRAIN_GRASS_COLOR_FILE = `${TERRAIN_ASSET_DIR}/grass-color.png`
/**
 * ThreejsClient-only grass field manifest (Unity/Godot Explorer ignore).
 * Points at density/color/height sidecars; client rebuilds InstancedMesh from them.
 */
export const TERRAIN_GRASS_MANIFEST_FILE = `${TERRAIN_ASSET_DIR}/grass.json`
export const TERRAIN_GLB_FILE = `${TERRAIN_ASSET_DIR}/terrain.glb`

/** Manifest schema version — bump when sidecar layout changes. */
export const TERRAIN_GRASS_MANIFEST_VERSION = 1 as const

export type TerrainGrassManifest = {
  /** Always ThreejsClient — not SDK7 entities. */
  client: 'threejsclient'
  version: typeof TERRAIN_GRASS_MANIFEST_VERSION
  format: 'density+rgb+heights'
  resolution: number
  files: {
    density: string
    color: string
    heights: string
  }
  note: string
}

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

/** Above this parcel count, export one capped footprint mesh instead of one plane per parcel. */
export const TERRAIN_MERGED_EXPORT_PARCEL_THRESHOLD = 512
/** Max plane segments per axis for merged large-footprint export (keeps GLB build under ~1M verts). */
export const TERRAIN_MERGED_EXPORT_MAX_SEGS_PER_AXIS = 512