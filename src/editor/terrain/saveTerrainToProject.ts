import { writeFileBytes, readFileText } from '../localScene/localFileSystem'
import { encodeHeightsBin } from './heightmapHeightsBin'
import { imageDataFromHeights, imageDataToPngBlob } from './heightmapCodec'
import { exportTerrainGlb } from './exportTerrainGlb'
import { mergeTerrainIntoComposite } from '../composite/terrainComposite'
import {
  TERRAIN_GLB_FILE,
  TERRAIN_HEIGHTMAP_FILE,
  TERRAIN_HEIGHTS_BIN_FILE,
  TERRAIN_LAVA_FILE,
  TERRAIN_SPLAT_FILE
} from './terrainSculptConstants'
import type { EditorTerrainSystem } from './EditorTerrainSystem'

const COMPOSITE_PATH = 'assets/scene/main.composite'

export type TerrainSaveResult = {
  ok: boolean
  message: string
  paths: string[]
}

export async function saveTerrainToProject(
  root: FileSystemDirectoryHandle,
  terrain: EditorTerrainSystem,
  terrainPosition: { x: number; y: number; z: number }
): Promise<TerrainSaveResult> {
  const { heights, splat, lava } = terrain.getBuffers()
  const resolution = terrain.resolution

  const heightImg = imageDataFromHeights(heights, resolution)
  const splatImg = new ImageData(resolution, resolution)
  splatImg.data.set(splat)
  const lavaImg = new ImageData(resolution, resolution)
  for (let i = 0; i < lava.length; i++) {
    const v = lava[i]!
    const o = i * 4
    lavaImg.data[o] = v
    lavaImg.data[o + 1] = v
    lavaImg.data[o + 2] = v
    lavaImg.data[o + 3] = 255
  }

  const paths: string[] = []

  const heightsBin = encodeHeightsBin(heights, resolution)
  await writeFileBytes(root, TERRAIN_HEIGHTS_BIN_FILE, heightsBin)
  paths.push(TERRAIN_HEIGHTS_BIN_FILE)

  const heightPng = await imageDataToPngBlob(heightImg)
  await writeFileBytes(root, TERRAIN_HEIGHTMAP_FILE, new Uint8Array(await heightPng.arrayBuffer()))
  paths.push(TERRAIN_HEIGHTMAP_FILE)

  const splatPng = await imageDataToPngBlob(splatImg)
  await writeFileBytes(root, TERRAIN_SPLAT_FILE, new Uint8Array(await splatPng.arrayBuffer()))
  paths.push(TERRAIN_SPLAT_FILE)

  const lavaPng = await imageDataToPngBlob(lavaImg)
  await writeFileBytes(root, TERRAIN_LAVA_FILE, new Uint8Array(await lavaPng.arrayBuffer()))
  paths.push(TERRAIN_LAVA_FILE)

  const glb = await exportTerrainGlb(terrain)
  await writeFileBytes(root, TERRAIN_GLB_FILE, glb)
  paths.push(TERRAIN_GLB_FILE)

  const existingComposite = await readFileText(root, COMPOSITE_PATH)
  if (existingComposite) {
    await writeFileBytes(
      root,
      `${COMPOSITE_PATH}.bak`,
      new TextEncoder().encode(existingComposite)
    )
  }
  const merged = mergeTerrainIntoComposite(existingComposite, {
    glbSrc: TERRAIN_GLB_FILE,
    position: terrainPosition
  })
  await writeFileBytes(root, COMPOSITE_PATH, new TextEncoder().encode(merged))
  paths.push(COMPOSITE_PATH)

  return {
    ok: true,
    message: `Saved ${paths.length} files. Run dcl deploy to publish.`,
    paths
  }
}