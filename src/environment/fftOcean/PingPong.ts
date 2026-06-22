import * as THREE from 'three'

export class PingPong {
  readonly targetA: THREE.WebGLRenderTarget
  readonly targetB: THREE.WebGLRenderTarget
  readTarget: THREE.WebGLRenderTarget
  writeTarget: THREE.WebGLRenderTarget

  constructor(resolution: number) {
    const options: THREE.RenderTargetOptions = {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false,
      count: 3,
      wrapS: THREE.RepeatWrapping,
      wrapT: THREE.RepeatWrapping
    }

    this.targetA = new THREE.WebGLRenderTarget(resolution, resolution, options)
    this.targetB = new THREE.WebGLRenderTarget(resolution, resolution, options)
    this.readTarget = this.targetA
    this.writeTarget = this.targetB
  }

  swap(): void {
    const temp = this.readTarget
    this.readTarget = this.writeTarget
    this.writeTarget = temp
  }

  dispose(): void {
    this.targetA.dispose()
    this.targetB.dispose()
  }
}