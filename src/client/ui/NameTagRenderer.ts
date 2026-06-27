import type { Camera, Scene } from 'three'
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'

/** Renders CSS2D name tags on top of the WebGL canvas. */
export class NameTagRenderer {
  private readonly renderer: CSS2DRenderer
  readonly domElement: HTMLElement

  constructor(container: HTMLElement) {
    this.renderer = new CSS2DRenderer()
    this.renderer.setSize(window.innerWidth, window.innerHeight)
    const dom = this.renderer.domElement
    dom.className = 'name-tag-layer'
    this.domElement = dom
    container.appendChild(dom)
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height)
  }

  render(scene: Scene, camera: Camera): void {
    this.renderer.render(scene, camera)
  }

  dispose(): void {
    this.renderer.domElement.remove()
  }
}