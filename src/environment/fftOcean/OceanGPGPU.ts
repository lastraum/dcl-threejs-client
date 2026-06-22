import * as THREE from 'three'
import { generateButterflyTexture } from './ButterflyTexture'
import { ComputePass } from './ComputePass'
import { PingPong } from './PingPong'
import {
  BUTTERFLY_FRAG,
  GPGPU_VERT,
  GPGPU_VERT_GLSL3,
  INITIAL_SPECTRUM_FRAG,
  TIME_EVOLUTION_FRAG
} from './shaders'

export type OceanGPGPUOptions = {
  resolution: number
  patchSize: number
  amplitude: number
  windSpeed: number
  windDirection: THREE.Vector2
}

export type OceanDisplacementTextures = {
  displacementY: THREE.Texture
  displacementX: THREE.Texture
  displacementZ: THREE.Texture
}

/** GPU FFT ocean simulation — ported from FFTOCEAN `useOceanGPGPU`. */
export class OceanGPGPU {
  readonly resolution: number
  private readonly h0Target: THREE.WebGLRenderTarget
  private readonly pingpong: PingPong
  private readonly computePass: ComputePass
  private readonly butterflyMaterial: THREE.ShaderMaterial
  private readonly timeEvolutionMaterial: THREE.ShaderMaterial
  private readonly butterflyTexture: THREE.DataTexture
  private readonly initialSpectrumMaterial: THREE.ShaderMaterial

  constructor(options: OceanGPGPUOptions) {
    const { resolution, patchSize, amplitude, windSpeed, windDirection } = options
    this.resolution = resolution

    this.h0Target = new THREE.WebGLRenderTarget(resolution, resolution, {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      format: THREE.RGBAFormat,
      depthBuffer: false,
      stencilBuffer: false,
      generateMipmaps: false
    })

    this.pingpong = new PingPong(resolution)
    this.butterflyTexture = generateButterflyTexture(resolution)

    this.butterflyMaterial = new THREE.ShaderMaterial({
      vertexShader: GPGPU_VERT_GLSL3,
      fragmentShader: BUTTERFLY_FRAG,
      uniforms: {
        uStage: { value: 0 },
        uStages: { value: Math.log2(resolution) },
        uDirection: { value: 0 },
        uPingPongTextureY: { value: null },
        uPingPongTextureX: { value: null },
        uPingPongTextureZ: { value: null },
        uButterflyTexture: { value: this.butterflyTexture }
      },
      glslVersion: THREE.GLSL3
    })

    this.timeEvolutionMaterial = new THREE.ShaderMaterial({
      vertexShader: GPGPU_VERT_GLSL3,
      fragmentShader: TIME_EVOLUTION_FRAG,
      uniforms: {
        uH0Target: { value: this.h0Target.texture },
        uResolution: { value: resolution },
        uTime: { value: 0 },
        uPatchSize: { value: patchSize }
      },
      glslVersion: THREE.GLSL3
    })

    this.computePass = new ComputePass(this.butterflyMaterial)

    this.initialSpectrumMaterial = new THREE.ShaderMaterial({
      vertexShader: GPGPU_VERT,
      fragmentShader: INITIAL_SPECTRUM_FRAG,
      uniforms: {
        uResolution: { value: resolution },
        uPatchSize: { value: patchSize },
        uAmplitude: { value: amplitude },
        uWindSpeed: { value: windSpeed },
        uWindDirection: { value: windDirection }
      }
    })
  }

  /** Bake Phillips spectrum into h0Target (call once at init). */
  bakeInitialSpectrum(renderer: THREE.WebGLRenderer): void {
    const prev = renderer.getRenderTarget()
    const loopMaterial = this.computePass.material
    this.computePass.setMaterial(this.initialSpectrumMaterial)
    this.computePass.render(renderer, this.h0Target)
    this.computePass.setMaterial(loopMaterial)
    renderer.setRenderTarget(prev)
  }

  update(renderer: THREE.WebGLRenderer, time: number): OceanDisplacementTextures {
    const prev = renderer.getRenderTarget()
    const { pingpong, computePass, butterflyMaterial, timeEvolutionMaterial } = this
    const iterations = Math.log2(this.resolution)

    timeEvolutionMaterial.uniforms.uTime.value = time
    computePass.setMaterial(timeEvolutionMaterial)
    computePass.render(renderer, pingpong.writeTarget)
    pingpong.swap()

    computePass.setMaterial(butterflyMaterial)

    const setPingPongUniforms = () => {
      butterflyMaterial.uniforms.uPingPongTextureY.value = pingpong.readTarget.textures[0]
      butterflyMaterial.uniforms.uPingPongTextureX.value = pingpong.readTarget.textures[1]
      butterflyMaterial.uniforms.uPingPongTextureZ.value = pingpong.readTarget.textures[2]
    }

    butterflyMaterial.uniforms.uDirection.value = 0
    for (let i = 0; i < iterations; i++) {
      butterflyMaterial.uniforms.uStage.value = i
      setPingPongUniforms()
      computePass.render(renderer, pingpong.writeTarget)
      pingpong.swap()
    }

    butterflyMaterial.uniforms.uDirection.value = 1
    for (let i = 0; i < iterations; i++) {
      butterflyMaterial.uniforms.uStage.value = i
      setPingPongUniforms()
      computePass.render(renderer, pingpong.writeTarget)
      pingpong.swap()
    }

    renderer.setRenderTarget(prev)

    return {
      displacementY: pingpong.readTarget.textures[0]!,
      displacementX: pingpong.readTarget.textures[1]!,
      displacementZ: pingpong.readTarget.textures[2]!
    }
  }

  /** GPGPU passes per update (time evolution + horizontal + vertical butterfly). */
  passesPerUpdate(): number {
    return 1 + Math.log2(this.resolution) * 2
  }

  dispose(): void {
    this.h0Target.dispose()
    this.pingpong.dispose()
    this.butterflyTexture.dispose()
    this.initialSpectrumMaterial.dispose()
    this.timeEvolutionMaterial.dispose()
    this.butterflyMaterial.dispose()
    this.computePass.dispose()
  }
}