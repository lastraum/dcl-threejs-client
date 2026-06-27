import * as THREE from 'three'

/** RGB axis lines at the SW corner of the parcel (X red, Y green, Z blue). */
export class EditorAxisGizmo {
  private readonly group = new THREE.Group()

  constructor(originX: number, originY: number, originZ: number, lengthM = 10) {
    const axes: Array<{ dir: THREE.Vector3; color: number }> = [
      { dir: new THREE.Vector3(1, 0, 0), color: 0xff4444 },
      { dir: new THREE.Vector3(0, 1, 0), color: 0x44ff44 },
      { dir: new THREE.Vector3(0, 0, 1), color: 0x4488ff }
    ]
    for (const { dir, color } of axes) {
      const end = dir.clone().multiplyScalar(lengthM)
      const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), end])
      const mat = new THREE.LineBasicMaterial({
        color,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 0.95
      })
      const line = new THREE.Line(geo, mat)
      line.renderOrder = 12
      this.group.add(line)
    }
    this.group.position.set(originX, originY, originZ)
    this.group.renderOrder = 12
  }

  mount(scene: THREE.Scene): void {
    scene.add(this.group)
  }

  dispose(): void {
    this.group.removeFromParent()
    for (const child of this.group.children) {
      const line = child as THREE.Line
      line.geometry.dispose()
      ;(line.material as THREE.Material).dispose()
    }
  }
}