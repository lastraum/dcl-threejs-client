import { readFileBytes } from '../localScene/localFileSystem'
import { decodeHeightsBin } from './heightmapHeightsBin'
import { heightsFromImageData } from './heightmapCodec'
import {
  TERRAIN_HEIGHTMAP_FILE,
  TERRAIN_HEIGHTS_BIN_FILE,
  TERRAIN_LAVA_FILE,
  TERRAIN_SPLAT_FILE
} from './terrainSculptConstants'
import type { EditorTerrainSystem } from './EditorTerrainSystem'

async function loadPngPixels(root: FileSystemDirectoryHandle, path: string, resolution: number): Promise<ImageData | null> {
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

export async function loadTerrainFromProject(
  root: FileSystemDirectoryHandle,
  terrain: EditorTerrainSystem
): Promise<void> {
  const resolution = terrain.resolution
  const binBytes = await readFileBytes(root, TERRAIN_HEIGHTS_BIN_FILE)
  if (binBytes) {
    const buf = binBytes.buffer.slice(binBytes.byteOffset, binBytes.byteOffset + binBytes.byteLength)
    const decoded = decodeHeightsBin(buf as ArrayBuffer)
    if (decoded && decoded.resolution === resolution) {
      terrain.setHeights(decoded.heights)
    }
  } else {
    const png = await loadPngPixels(root, TERRAIN_HEIGHTMAP_FILE, resolution)
    if (png) {
      terrain.setHeights(heightsFromImageData(png, resolution))
    }
  }

  const splatPng = await loadPngPixels(root, TERRAIN_SPLAT_FILE, resolution)
  if (splatPng) {
    terrain.setSplat(new Uint8Array(splatPng.data))
  }

  const lavaPng = await loadPngPixels(root, TERRAIN_LAVA_FILE, resolution)
  if (lavaPng) {
    const lava = new Uint8Array(resolution * resolution)
    for (let i = 0; i < lava.length; i++) lava[i] = lavaPng.data[i * 4]!
    terrain.setLava(lava)
  }
}