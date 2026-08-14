import * as THREE from 'three'
import { dclToThreePos } from '../bridge/dclTransform'
import { PARCEL_SIZE } from '../dcl/content/types'
import type { SceneWorldBounds } from '../player/SceneBounds'

/**
 * Full scene footprint outline in the terrain editor.
 * Outer wall = world boundary; optional inner parcel grid lines (cheap LineSegments).
 * Unlike GridHelper, this always matches the true rectangular bounds (not max×max square).
 */
export class EditorWorldBoundaryOutline {
  private readonly group = new THREE.Group()
  private outer: THREE.LineSegments | null = null
  private parcels: THREE.LineSegments | null = null
  private visible = true

  constructor(
    private readonly bounds: SceneWorldBounds,
    opts?: { showParcelLines?: boolean; y?: number }
  ) {
    this.group.name = 'editor-world-boundary'
    const y = opts?.y ?? 0.08
    this.outer = this.buildOuter(y)
    this.group.add(this.outer)
    if (opts?.showParcelLines !== false) {
      this.parcels = this.buildParcelLines(y)
      if (this.parcels) this.group.add(this.parcels)
    }
    this.group.visible = this.visible
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  setVisible(visible: boolean): void {
    this.visible = visible
    this.group.visible = visible
  }

  getVisible(): boolean {
    return this.visible
  }

  /** Toggle internal parcel divisions only (outer boundary stays). */
  setParcelLinesVisible(visible: boolean): void {
    if (this.parcels) this.parcels.visible = visible
  }

  dispose(): void {
    for (const line of [this.outer, this.parcels]) {
      if (!line) continue
      this.group.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    this.outer = null
    this.parcels = null
    this.group.removeFromParent()
  }

  private buildOuter(y: number): THREE.LineSegments {
    const { minX, maxX, minZ, maxZ } = this.bounds
    // Closed rectangle corners (DCL XZ → Three)
    const c00 = dclToThreePos(minX, y, minZ)
    const c10 = dclToThreePos(maxX, y, minZ)
    const c11 = dclToThreePos(maxX, y, maxZ)
    const c01 = dclToThreePos(minX, y, maxZ)
    const positions = new Float32Array([
      c00.x, c00.y, c00.z, c10.x, c10.y, c10.z,
      c10.x, c10.y, c10.z, c11.x, c11.y, c11.z,
      c11.x, c11.y, c11.z, c01.x, c01.y, c01.z,
      c01.x, c01.y, c01.z, c00.x, c00.y, c00.z
    ])
    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0x5eead4,
      transparent: true,
      opacity: 0.95,
      depthTest: false,
      depthWrite: false
    })
    const lines = new THREE.LineSegments(geo, mat)
    lines.renderOrder = 12
    lines.name = 'editor-world-boundary-outer'
    return lines
  }

  private buildParcelLines(y: number): THREE.LineSegments | null {
    const { minX, maxX, minZ, maxZ } = this.bounds
    const widthM = maxX - minX
    const depthM = maxZ - minZ
    const cols = Math.max(1, Math.round(widthM / PARCEL_SIZE))
    const rows = Math.max(1, Math.round(depthM / PARCEL_SIZE))
    // Cap inner lines for huge multi-parcel worlds (outer boundary always drawn).
    if (cols * rows > 400) return null

    const pts: number[] = []
    const pushSeg = (x0: number, z0: number, x1: number, z1: number) => {
      const a = dclToThreePos(x0, y, z0)
      const b = dclToThreePos(x1, y, z1)
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z)
    }

    // Internal vertical (constant X) and horizontal (constant Z) parcel edges — skip outer (already bright).
    for (let i = 1; i < cols; i++) {
      const x = minX + i * PARCEL_SIZE
      pushSeg(x, minZ, x, maxZ)
    }
    for (let j = 1; j < rows; j++) {
      const z = minZ + j * PARCEL_SIZE
      pushSeg(minX, z, maxX, z)
    }
    if (pts.length === 0) return null

    const geo = new THREE.BufferGeometry()
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3))
    const mat = new THREE.LineBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.55,
      depthTest: false,
      depthWrite: false
    })
    const lines = new THREE.LineSegments(geo, mat)
    lines.renderOrder = 11
    lines.name = 'editor-world-boundary-parcels'
    return lines
  }
}
