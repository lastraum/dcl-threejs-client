/**
 * Rising cyan motes in the walker's wake — same sparks as the landing disc.
 */
import * as THREE from 'three'

const COUNT = 96
const STEP_M = 0.22
const BURST = 3
const SIZE = 0.42

const VERT = /* glsl */ `
uniform float uSize;
attribute float aFade;
varying float vFade;
void main() {
  vFade = aFade;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = clamp(uSize * (220.0 / max(0.4, -mv.z)), 3.0, 72.0);
  gl_Position = projectionMatrix * mv;
}
`

const FRAG = /* glsl */ `
uniform sampler2D map;
varying float vFade;
void main() {
  vec4 t = texture2D(map, gl_PointCoord);
  float a = t.a * vFade;
  if (a < 0.02) discard;
  vec3 col = t.rgb * vec3(0.72, 0.96, 1.0);
  gl_FragColor = vec4(col, a);
}
`

function makeSparkTexture(): THREE.Texture {
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = 64
  const ctx = canvas.getContext('2d')!
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32)
  g.addColorStop(0, 'rgba(255,255,255,1)')
  g.addColorStop(0.28, 'rgba(160,236,255,0.85)')
  g.addColorStop(1, 'rgba(80,180,210,0)')
  ctx.fillStyle = g
  ctx.fillRect(0, 0, 64, 64)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  return tex
}

export class ForestWalkTrail {
  private readonly points: THREE.Points
  private readonly geo: THREE.BufferGeometry
  private readonly mat: THREE.ShaderMaterial
  private readonly tex: THREE.Texture
  private readonly pos: Float32Array
  private readonly fade: Float32Array
  private readonly fadeAttr: THREE.BufferAttribute
  private readonly posAttr: THREE.BufferAttribute
  private readonly age = new Float32Array(COUNT)
  private readonly life = new Float32Array(COUNT)
  private readonly vx = new Float32Array(COUNT)
  private readonly vy = new Float32Array(COUNT)
  private readonly vz = new Float32Array(COUNT)
  private next = 0
  private lastX = 0
  private lastZ = 0
  private primed = false

  constructor(scene: THREE.Scene) {
    this.tex = makeSparkTexture()
    this.pos = new Float32Array(COUNT * 3)
    this.fade = new Float32Array(COUNT)
    this.geo = new THREE.BufferGeometry()
    this.posAttr = new THREE.BufferAttribute(this.pos, 3)
    this.fadeAttr = new THREE.BufferAttribute(this.fade, 1)
    this.posAttr.setUsage(THREE.DynamicDrawUsage)
    this.fadeAttr.setUsage(THREE.DynamicDrawUsage)
    this.geo.setAttribute('position', this.posAttr)
    this.geo.setAttribute('aFade', this.fadeAttr)
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        map: { value: this.tex },
        uSize: { value: SIZE }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false
    })
    this.points = new THREE.Points(this.geo, this.mat)
    this.points.name = 'forest-walk-trail'
    this.points.frustumCulled = false
    this.points.renderOrder = 6
    for (let i = 0; i < COUNT; i++) this.age[i] = 99
    scene.add(this.points)
  }

  update(dt: number, _time: number, x: number, z: number, moving: boolean, yaw: number): void {
    if (!this.primed) {
      this.lastX = x
      this.lastZ = z
      this.primed = true
    }

    if (moving) {
      const dx = x - this.lastX
      const dz = z - this.lastZ
      let dist = Math.hypot(dx, dz)
      if (dist >= STEP_M) {
        const inv = 1 / dist
        const ux = dx * inv
        const uz = dz * inv
        let dropped = 0
        while (dist >= STEP_M && dropped < 6) {
          this.lastX += ux * STEP_M
          this.lastZ += uz * STEP_M
          this.drop(this.lastX, this.lastZ, yaw)
          dist -= STEP_M
          dropped++
        }
      }
    } else {
      this.lastX = x
      this.lastZ = z
    }

    for (let i = 0; i < COUNT; i++) {
      if (this.age[i]! >= this.life[i]!) {
        this.fade[i] = 0
        continue
      }
      this.age[i]! += dt
      const t = Math.min(1, this.age[i]! / Math.max(this.life[i]!, 1e-4))
      this.fade[i] = Math.max(0, 1 - t * t)
      const o = i * 3
      this.pos[o]! += this.vx[i]! * dt
      this.pos[o + 1]! += this.vy[i]! * dt
      this.pos[o + 2]! += this.vz[i]! * dt
    }
    this.posAttr.needsUpdate = true
    this.fadeAttr.needsUpdate = true
  }

  dispose(): void {
    this.points.removeFromParent()
    this.geo.dispose()
    this.mat.dispose()
    this.tex.dispose()
  }

  private drop(x: number, z: number, yaw: number): void {
    const backX = Math.sin(yaw)
    const backZ = Math.cos(yaw)
    const rightX = Math.cos(yaw)
    const rightZ = -Math.sin(yaw)
    for (let n = 0; n < BURST; n++) {
      const i = this.next
      this.next = (this.next + 1) % COUNT
      const side = (Math.random() * 2 - 1) * 0.22
      const back = 0.08 + Math.random() * 0.28
      const life = 1.15 + Math.random() * 1.45
      this.age[i] = 0
      this.life[i] = life
      this.fade[i] = 1
      this.vx[i] = rightX * side * 0.35 + backX * (0.04 + Math.random() * 0.12)
      this.vy[i] = 0.55 + life * 0.28
      this.vz[i] = rightZ * side * 0.35 + backZ * (0.04 + Math.random() * 0.12)
      const o = i * 3
      this.pos[o] = x - backX * back + rightX * side
      this.pos[o + 1] = 0.08 + Math.random() * 0.12
      this.pos[o + 2] = z - backZ * back + rightZ * side
    }
  }
}
