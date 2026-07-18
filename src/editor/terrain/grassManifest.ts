import {
  TERRAIN_GRASS_COLOR_FILE,
  TERRAIN_GRASS_FILE,
  TERRAIN_GRASS_MANIFEST_FILE,
  TERRAIN_GRASS_MANIFEST_VERSION,
  TERRAIN_HEIGHTS_BIN_FILE,
  type TerrainGrassManifest
} from './terrainSculptConstants'

/** Build the ThreejsClient-only grass field manifest written next to terrain assets. */
export function buildGrassManifest(resolution: number): TerrainGrassManifest {
  return {
    client: 'threejsclient',
    version: TERRAIN_GRASS_MANIFEST_VERSION,
    format: 'density+rgb+heights',
    resolution,
    files: {
      density: TERRAIN_GRASS_FILE,
      color: TERRAIN_GRASS_COLOR_FILE,
      heights: TERRAIN_HEIGHTS_BIN_FILE
    },
    note:
      'ThreejsClient only — density/color/heights drive InstancedMesh grass.glb (no hard instance cap). Not DCL SDK entities; Unity/Godot Explorer ignore these sidecars.'
  }
}

export function grassManifestJson(resolution: number): string {
  return `${JSON.stringify(buildGrassManifest(resolution), null, 2)}\n`
}

export { TERRAIN_GRASS_MANIFEST_FILE }
