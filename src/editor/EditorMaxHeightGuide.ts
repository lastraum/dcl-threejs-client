import * as THREE from 'three'
import { dclToThreePos } from '../bridge/dclTransform'

export type MaxHeightGuideSample = {
  maxY: number
  peakX: number
  peakZ: number
}

function makeLine(points: THREE.Vector3[], color: number, opacity = 0.9): THREE.Line {
  const geo = new THREE.BufferGeometry().setFromPoints(points)
  const mat = new THREE.LineBasicMaterial({
    color,
    transparent: true,
    opacity,
    depthTest: false,
    depthWrite: false
  })
  const line = new THREE.Line(geo, mat)
  line.renderOrder = 11
  return line
}

/** G-toggle: max-terrain height reference from SW axis to peak. */
export class EditorMaxHeightGuide {
  private readonly group = new THREE.Group()
  private visible = false
  private axisLine: THREE.Line | null = null
  private peakLine: THREE.Line | null = null
  private spanLine: THREE.Line | null = null
  private connectorLine: THREE.Line | null = null

  constructor(
    private readonly axisX: number,
    private readonly axisZ: number,
    private readonly minX: number,
    private readonly maxX: number
  ) {}

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

  update(sample: MaxHeightGuideSample | null): void {
    this.disposeLines()
    if (!sample || !this.visible) return

    const { maxY, peakX, peakZ } = sample
    const y = maxY + 0.04
    const axis = dclToThreePos(this.axisX, 0.08, this.axisZ)
    const axisTop = dclToThreePos(this.axisX, y, this.axisZ)
    const peakBase = dclToThreePos(peakX, 0.08, peakZ)
    const peakTop = dclToThreePos(peakX, y, peakZ)
    const spanA = dclToThreePos(this.minX, y, peakZ)
    const spanB = dclToThreePos(this.maxX, y, peakZ)

    this.axisLine = makeLine([axis, axisTop], 0x66ccff, 0.95)
    this.peakLine = makeLine([peakBase, peakTop], 0xffcc44, 0.9)
    this.spanLine = makeLine([spanA, spanB], 0xffee66, 0.85)
    this.connectorLine = makeLine([axisTop, peakTop], 0xffee66, 0.75)

    for (const line of [this.axisLine, this.peakLine, this.spanLine, this.connectorLine]) {
      this.group.add(line)
    }
  }

  private disposeLines(): void {
    for (const line of [this.axisLine, this.peakLine, this.spanLine, this.connectorLine]) {
      if (!line) continue
      this.group.remove(line)
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
    this.axisLine = null
    this.peakLine = null
    this.spanLine = null
    this.connectorLine = null
  }

  dispose(): void {
    this.disposeLines()
    this.group.removeFromParent()
  }
}