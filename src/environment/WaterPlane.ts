import * as THREE from 'three'
import { parseParcelKey } from '../dcl/content/parseParcel'
import { PARCEL_SIZE } from '../dcl/content/types'
import { parcelWorldOrigin } from '../dcl/landscape/Utils/SceneSpace'
import { dclToThreePos } from '../bridge/dclTransform'
import { landscapeParcelKeys } from '../dcl/landscape/Utils/ParcelGrid'

const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying float vElevation;
  uniform float uTime;

  void main() {
    vUv = uv;
    vec4 world = modelMatrix * vec4(position, 1.0);
    float wave = sin(world.x * 0.08 + uTime * 0.9) * 0.06
               + sin(world.z * 0.06 + uTime * 0.7) * 0.05;
    vElevation = wave;
    vec3 pos = position;
    pos.y += wave;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  varying vec2 vUv;
  varying float vElevation;
  uniform float uTime;
  uniform vec3 uDeepColor;
  uniform vec3 uShallowColor;

  void main() {
    float ripple = sin(vUv.x * 24.0 + uTime * 1.2) * 0.5 + 0.5;
    ripple *= sin(vUv.y * 18.0 - uTime * 0.8) * 0.5 + 0.5;
    vec3 color = mix(uDeepColor, uShallowColor, ripple * 0.35 + vElevation * 2.0 + 0.25);
    float alpha = 0.92;
    gl_FragColor = vec4(color, alpha);
  }
`

/** Simple animated water beneath the landscape — replaces flat cyan horizon fill. */
export class WaterPlane {
  readonly mesh: THREE.Mesh
  private readonly uniforms: {
    uTime: { value: number }
    uDeepColor: { value: THREE.Color }
    uShallowColor: { value: THREE.Color }
  }
  private elapsed = 0

  constructor(parcels: string[], baseParcel: string, padding = 1) {
    const keys = landscapeParcelKeys(parcels, padding)
    const base = parseParcelKey(baseParcel)
    let minX = Infinity
    let maxX = -Infinity
    let minZ = Infinity
    let maxZ = -Infinity

    for (const key of keys) {
      const parcel = parseParcelKey(key)
      const origin = parcelWorldOrigin(parcel, base)
      minX = Math.min(minX, origin.x)
      maxX = Math.max(maxX, origin.x + PARCEL_SIZE)
      minZ = Math.min(minZ, origin.z)
      maxZ = Math.max(maxZ, origin.z + PARCEL_SIZE)
    }

    /** Extend well past the landscape so the horizon never clips a square edge. */
    const minExtent = 1024
    const width = Math.max(maxX - minX + PARCEL_SIZE * 8, minExtent)
    const depth = Math.max(maxZ - minZ + PARCEL_SIZE * 8, minExtent)
    const cx = (minX + maxX) * 0.5
    const cz = (minZ + maxZ) * 0.5

    this.uniforms = {
      uTime: { value: 0 },
      uDeepColor: { value: new THREE.Color(0x0a3d5c) },
      uShallowColor: { value: new THREE.Color(0x2a8fad) }
    }

    const material = new THREE.ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false
    })

    const geometry = new THREE.PlaneGeometry(width, depth, 48, 48)
    geometry.rotateX(-Math.PI / 2)

    this.mesh = new THREE.Mesh(geometry, material)
    this.mesh.name = 'water-plane'
    dclToThreePos(cx, -0.35, cz, this.mesh.position)
    this.mesh.renderOrder = -2
    this.mesh.frustumCulled = false
  }

  update(delta: number): void {
    this.elapsed += delta
    this.uniforms.uTime.value = this.elapsed
  }

  dispose(): void {
    this.mesh.geometry.dispose()
    ;(this.mesh.material as THREE.Material).dispose()
  }
}
