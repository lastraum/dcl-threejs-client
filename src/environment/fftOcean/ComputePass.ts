import * as THREE from 'three'

export class ComputePass {
  readonly camera: THREE.OrthographicCamera
  readonly scene: THREE.Scene
  readonly geometry: THREE.PlaneGeometry
  readonly mesh: THREE.Mesh
  material: THREE.ShaderMaterial

  constructor(material: THREE.ShaderMaterial) {
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1)
    this.scene = new THREE.Scene()
    this.geometry = new THREE.PlaneGeometry(2, 2)
    this.material = material
    this.mesh = new THREE.Mesh(this.geometry, this.material)
    this.scene.add(this.mesh)
  }

  setMaterial(material: THREE.ShaderMaterial): void {
    this.mesh.material = material
    this.material = material
  }

  render(renderer: THREE.WebGLRenderer, target: THREE.WebGLRenderTarget | null = null): void {
    renderer.setRenderTarget(target)
    renderer.render(this.scene, this.camera)
  }

  dispose(): void {
    this.geometry.dispose()
    this.material.dispose()
  }
}