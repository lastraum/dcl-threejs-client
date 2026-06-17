import * as THREE from 'three'
import type { PBPointerEvents_Entry } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/pointer_events.gen'
import { InteractionType } from './pointerConstants'

const HIGHLIGHT_IN_RANGE = 0x44ff66
const HIGHLIGHT_OUT_OF_RANGE = 0xff4444
const OUTLINE_SCALE = 1.025

/** Entity mesh outline — green in range, red when too far (Explorer desktop parity). */
export class PointerHighlightFeedback {
  private readonly shells: THREE.Mesh[] = []
  private readonly materials: THREE.MeshBasicMaterial[] = []
  private activeKey = ''

  dispose(): void {
    this.clear()
  }

  shouldShow(entries: ReadonlyArray<PBPointerEvents_Entry>): boolean {
    for (const entry of entries) {
      if ((entry.interactionType ?? InteractionType.CURSOR) !== InteractionType.CURSOR) continue
      const info = entry.eventInfo
      if (info?.showFeedback === false) continue
      if (info?.showHighlight === false) continue
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
      const mat = new THREE.MeshBasicMaterial({
        color,
        side: THREE.BackSide,
        transparent: true,
        opacity: 0.85,
        depthTest: true,
        depthWrite: false
      })
      const shell = new THREE.Mesh(mesh.geometry, mat)
      shell.name = '__pointer_highlight__'
      shell.renderOrder = mesh.renderOrder + 20
      shell.frustumCulled = mesh.frustumCulled
      shell.scale.set(OUTLINE_SCALE, OUTLINE_SCALE, OUTLINE_SCALE)
      shell.position.set(0, 0, 0)
      shell.quaternion.identity()
      mesh.add(shell)
      this.shells.push(shell)
      this.materials.push(mat)
    }
  }

  clear(): void {
    for (const shell of this.shells) {
      shell.parent?.remove(shell)
    }
    for (const mat of this.materials) mat.dispose()
    this.shells.length = 0
    this.materials.length = 0
    this.activeKey = ''
  }
}
