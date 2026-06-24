import * as THREE from 'three'
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js'
import type { EditorTerrainSystem } from './EditorTerrainSystem'

const COLLIDER_SEGMENTS = 128

export async function exportTerrainGlb(terrain: EditorTerrainSystem): Promise<ArrayBuffer> {
  const { visible, collider } = terrain.buildExportMeshes(COLLIDER_SEGMENTS)
  const root = new THREE.Group()
  root.name = 'terrain_root'
  root.add(visible)
  root.add(collider)

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

  visible.geometry.dispose()
  ;(visible.material as THREE.Material).dispose()
  collider.geometry.dispose()
  ;(collider.material as THREE.Material).dispose()

  return glb
}