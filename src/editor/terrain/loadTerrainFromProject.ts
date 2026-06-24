import { readFileBytes } from '../localScene/localFileSystem'
import type { ProjectRoot } from '../localScene/projectRoot'
import { decodeHeightsBin } from './heightmapHeightsBin'
import { heightsFromImageData } from './heightmapCodec'
import {
  TERRAIN_HEIGHTMAP_FILE,
  TERRAIN_HEIGHTS_BIN_FILE,
  TERRAIN_LAVA_FILE,
  TERRAIN_SPLAT_FILE,
  type TerrainExportSettings
} from './terrainSculptConstants'
import type { EditorTerrainSystem } from './EditorTerrainSystem'
import { loadTerrainDraft, saveTerrainDraft } from './terrainEditorStore'

async function loadPngPixels(root: ProjectRoot, path: string, resolution: number): Promise<ImageData | null> {
  const bytes = await readFileBytes(root, path)
  if (!bytes) return null
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const blob = new Blob([copy], { type: 'image/png' })
  const url = URL.createObjectURL(blob)
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const el = new Image()
      el.onload = () => resolve(el)
      el.onerror = reject
      el.src = url
    })
    const canvas = document.createElement('canvas')
    canvas.width = resolution
    canvas.height = resolution
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, 0, 0, resolution, resolution)
    return ctx.getImageData(0, 0, resolution, resolution)
  } catch {
    return null
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** One-time import of legacy sidecar files from the project folder into IndexedDB. */
async function importLegacyTerrainFiles(
  projectId: string,
  root: ProjectRoot,
  terrain: EditorTerrainSystem
): Promise<boolean> {
  const resolution = terrain.resolution
  let imported = false

  const binBytes = await readFileBytes(root, TERRAIN_HEIGHTS_BIN_FILE)
  if (binBytes) {
    const buf = binBytes.buffer.slice(binBytes.byteOffset, binBytes.byteOffset + binBytes.byteLength)
    const decoded = decodeHeightsBin(buf as ArrayBuffer, resolution)
    if (decoded) {
      terrain.setHeights(decoded.heights)
      imported = true
    }
  } else {
    const png = await loadPngPixels(root, TERRAIN_HEIGHTMAP_FILE, resolution)
    if (png) {
      terrain.setHeights(heightsFromImageData(png, resolution))
      imported = true
    }
  }

  const splatPng = await loadPngPixels(root, TERRAIN_SPLAT_FILE, resolution)
  if (splatPng) {
    terrain.setSplat(new Uint8Array(splatPng.data))
    imported = true
  }

  const lavaPng = await loadPngPixels(root, TERRAIN_LAVA_FILE, resolution)
  if (lavaPng) {
    const lava = new Uint8Array(resolution * resolution)
    for (let i = 0; i < lava.length; i++) lava[i] = lavaPng.data[i * 4]!
    terrain.setLava(lava)
    imported = true
  }

  if (imported) {
    const { heights, splat, lava } = terrain.getBuffers()
    await saveTerrainDraft(projectId, {
      resolution,
      heights,
      splat,
      lava,
      proceduralShading: terrain.getProceduralShading()
    })
  }
  return imported
}

export type TerrainProjectLoad = {
  exportSettings?: TerrainExportSettings
}

export async function loadTerrainFromProject(
  projectId: string,
  root: ProjectRoot,
  terrain: EditorTerrainSystem
): Promise<TerrainProjectLoad> {
  const resolution = terrain.resolution
  const draft = await loadTerrainDraft(projectId, resolution)
  if (draft) {
    terrain.setHeights(draft.heights)
    terrain.setSplat(draft.splat)
    terrain.setLava(draft.lava)
    terrain.setProceduralShading(draft.proceduralShading)
    return { exportSettings: draft.exportSettings }
  }

  await importLegacyTerrainFiles(projectId, root, terrain)
  return {}
}