import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { EditorTerrainSystem } from './EditorTerrainSystem'
import { clampTerrainExportSegments } from './terrainSculptConstants'

function disposeExportRoot(root: THREE.Group): void {
  const materials = new Set<THREE.Material>()
  const textures = new Set<THREE.Texture>()
  root.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return
    obj.geometry.dispose()
    const mat = obj.material
    const mats = Array.isArray(mat) ? mat : [mat]
    for (const m of mats) {
      if (!m) continue
      materials.add(m)
      const basic = m as THREE.MeshBasicMaterial
      if (basic.map) textures.add(basic.map)
    }
  })
  for (const mat of materials) mat.dispose()
  for (const tex of textures) tex.dispose()
}

export async function exportTerrainGlb(
  terrain: EditorTerrainSystem,
  exportSegmentsPerParcel: number
): Promise<ArrayBuffer> {
  const root = terrain.buildExportMeshes(clampTerrainExportSegments(exportSegmentsPerParcel))

  const exporter = new GLTFExporter()
  const glb = await new Promise<ArrayBuffer>((resolve, reject) => {
    exporter.parse(
      root,
      (result) => {
        if (result instanceof ArrayBuffer) resolve(result)
        else reject(new Error('GLTFExporter returned JSON — expected binary'))
      },
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
      { binary: true }
    )
  })

  disposeExportRoot(root)
  return glb
}