import * as THREE from 'three'
import type { EditorFlyCamera } from './EditorFlyCamera'

/** Screen-space parcel compass — N = +Z, E = +X (scene space), Y up. */
export class EditorViewportCompass {
  private readonly root: HTMLDivElement
  private readonly ring: HTMLDivElement

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'editor-viewport-compass'
    this.root.innerHTML = `
      <div class="editor-compass-ring">
        <span class="editor-compass-label editor-compass-n">N</span>
        <span class="editor-compass-label editor-compass-e">E</span>
        <span class="editor-compass-label editor-compass-s">S</span>
        <span class="editor-compass-label editor-compass-w">W</span>
      </div>
      <div class="editor-compass-axes">
        <span><i class="editor-compass-axis-x">X</i> East</span>
        <span><i class="editor-compass-axis-y">Y</i> Up</span>
        <span><i class="editor-compass-axis-z">Z</i> North</span>
      </div>
    `
    parent.appendChild(this.root)
    this.ring = this.root.querySelector('.editor-compass-ring') as HTMLDivElement
  }

  updateFromCamera(camera: THREE.Camera, fly?: EditorFlyCamera | null): void {
    const yaw = fly?.getYaw() ?? this.yawFromCamera(camera)
    this.ring.style.transform = `rotate(${-yaw}rad)`
  }

  private yawFromCamera(camera: THREE.Camera): number {
    const dir = new THREE.Vector3()
    camera.getWorldDirection(dir)
    return Math.atan2(dir.x, dir.z)
  }

  dispose(): void {
    this.root.remove()
  }
}