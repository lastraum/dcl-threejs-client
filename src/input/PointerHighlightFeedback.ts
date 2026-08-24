import * as THREE from 'three'
import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
import { InteractionType } from './pointerConstants'

/**
 * SDK default is true. Explicit false/0 hides the outline (Cast Line, event cards).
 * Omitted (How To Play / See Tutorial) → outline; green in range, red out of range.
 */
export function pointerShowHighlight(info?: { showHighlight?: boolean | number } | null): boolean {
  if (!info) return true
  const value = info.showHighlight
  if (value === false || value === 0) return false
  return true
}

const HIGHLIGHT_IN_RANGE = 0x44ff66
const HIGHLIGHT_OUT_OF_RANGE = 0xff4444

/** Entity mesh outline — green in range, red when too far (Explorer desktop parity). */
export class PointerHighlightFeedback {
  private readonly shells: THREE.Object3D[] = []
  private readonly materials: THREE.LineBasicMaterial[] = []
  private readonly edgeGeoms: THREE.BufferGeometry[] = []
  private activeKey = ''

  dispose(): void {
    this.clear()
  }

  shouldShow(entries: ReadonlyArray<PBPointerEvents_Entry>): boolean {
    for (const entry of entries) {
      if ((entry.interactionType ?? InteractionType.CURSOR) !== InteractionType.CURSOR) continue
      const info = entry.eventInfo
      if (info?.showFeedback === false) continue
      if (!pointerShowHighlight(info)) continue
      return true
    }
    return false
  }

  update(meshes: ReadonlyArray<THREE.Mesh>, inRange: boolean): void {
    if (!meshes.length) {
      this.clear()
      return
    }

    const key = `${meshes.map((m) => m.uuid).join('|')}|${inRange ? 1 : 0}`
    if (key === this.activeKey && this.shells.length > 0) {
      const color = inRange ? HIGHLIGHT_IN_RANGE : HIGHLIGHT_OUT_OF_RANGE
      for (const mat of this.materials) mat.color.setHex(color)
      return
    }

    this.clear()
    this.activeKey = key
    const color = inRange ? HIGHLIGHT_IN_RANGE : HIGHLIGHT_OUT_OF_RANGE

    for (const mesh of meshes) {
      if (!mesh.geometry) continue
      // Back-face inflated mesh reads as a solid fill on thin door/glass planes.
      // Explorer showHighlight is an edge silhouette.
      const edges = new THREE.EdgesGeometry(mesh.geometry, 40)
      const mat = new THREE.LineBasicMaterial({
        color,
        depthTest: true,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      })
      const lines = new THREE.LineSegments(edges, mat)
      lines.name = '__pointer_highlight__'
      lines.renderOrder = mesh.renderOrder + 20
      lines.frustumCulled = mesh.frustumCulled
      mesh.add(lines)
      this.shells.push(lines)
      this.materials.push(mat)
      this.edgeGeoms.push(edges)
    }
  }

  clear(): void {
    for (const shell of this.shells) {
      shell.parent?.remove(shell)
    }
    for (const mat of this.materials) mat.dispose()
    for (const geom of this.edgeGeoms) geom.dispose()
    this.shells.length = 0
    this.materials.length = 0
    this.edgeGeoms.length = 0
    this.activeKey = ''
  }
}
