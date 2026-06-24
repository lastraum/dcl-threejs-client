import { encodeHeightsBin, decodeHeightsBin } from './heightmapHeightsBin'
import {
  DEFAULT_TERRAIN_EXPORT_SETTINGS,
  DEFAULT_TERRAIN_PROCEDURAL_SHADING,
  clampTerrainExportSegments,
  type TerrainExportSettings,
  type TerrainProceduralShading
} from './terrainSculptConstants'

const DB_NAME = 'dcl-editor-terrain'
const STORE_NAME = 'drafts'
const DB_VERSION = 1

export type TerrainEditorDraft = {
  projectId: string
  resolution: number
  heights: Float32Array
  splat: Uint8Array
  lava: Uint8Array
  proceduralShading: TerrainProceduralShading
  exportSettings: TerrainExportSettings
  updatedAt: number
}

type TerrainEditorDraftRecord = {
  resolution: number
  heightsBin: ArrayBuffer
  splat: Uint8Array
  lava: Uint8Array
  proceduralShading?: TerrainProceduralShading
  exportSettings?: TerrainExportSettings
  updatedAt: number
}

function normalizeProceduralShading(
  value: TerrainProceduralShading | undefined
): TerrainProceduralShading {
  return value ? { ...DEFAULT_TERRAIN_PROCEDURAL_SHADING, ...value } : { ...DEFAULT_TERRAIN_PROCEDURAL_SHADING }
}

function normalizeExportSettings(value: TerrainExportSettings | undefined): TerrainExportSettings {
  const merged = value
    ? { ...DEFAULT_TERRAIN_EXPORT_SETTINGS, ...value }
    : { ...DEFAULT_TERRAIN_EXPORT_SETTINGS }
  return {
    exportSegmentsPerParcel: clampTerrainExportSegments(merged.exportSegmentsPerParcel)
  }
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('terrain IndexedDB open failed'))
  })
}

export async function saveTerrainDraft(
  projectId: string,
  data: {
    resolution: number
    heights: Float32Array
    splat: Uint8Array
    lava: Uint8Array
    proceduralShading?: TerrainProceduralShading
    exportSettings?: TerrainExportSettings
  }
): Promise<void> {
  const record: TerrainEditorDraftRecord = {
    resolution: data.resolution,
    heightsBin: encodeHeightsBin(data.heights, data.resolution),
    splat: new Uint8Array(data.splat),
    lava: new Uint8Array(data.lava),
    proceduralShading: normalizeProceduralShading(data.proceduralShading),
    exportSettings: normalizeExportSettings(data.exportSettings),
    updatedAt: Date.now()
  }
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('terrain draft write failed'))
    tx.objectStore(STORE_NAME).put(record, projectId)
  })
}

export async function loadTerrainDraft(
  projectId: string,
  expectedResolution: number
): Promise<TerrainEditorDraft | null> {
  const db = await openDb()
  const record = await new Promise<TerrainEditorDraftRecord | null>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const req = tx.objectStore(STORE_NAME).get(projectId)
    req.onsuccess = () => resolve((req.result as TerrainEditorDraftRecord | undefined) ?? null)
    req.onerror = () => reject(req.error ?? new Error('terrain draft read failed'))
  })
  if (!record || record.resolution !== expectedResolution) return null
  const decoded = decodeHeightsBin(record.heightsBin, expectedResolution)
  if (!decoded) return null
  return {
    projectId,
    resolution: record.resolution,
    heights: decoded.heights,
    splat: new Uint8Array(record.splat),
    lava: new Uint8Array(record.lava),
    proceduralShading: normalizeProceduralShading(record.proceduralShading),
    exportSettings: normalizeExportSettings(record.exportSettings),
    updatedAt: record.updatedAt
  }
}

export async function deleteTerrainDraft(projectId: string): Promise<void> {
  const db = await openDb()
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error ?? new Error('terrain draft delete failed'))
    tx.objectStore(STORE_NAME).delete(projectId)
  })
}