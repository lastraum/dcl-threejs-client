/**
 * Meshy cracked-stone disc at spawn. World pools are ChargeField-style cyan
 * plates (water later); standing on a pool raises a filament curtain.
 */
import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { FOREST_LANDING_RADIUS_M } from './worldsForestLayout'

const GLB_URL = '/forest/landing/center-meshy.glb'

/**
 * Compact value-noise / ridged field. WebGL1-safe (no vec2.xyx swizzles).
 * Language is ChargeField from LinearAbilityExtThreeJS: seams, crawl, lip, pulse.
 */
const FOREST_NOISE_GLSL = /* glsl */ `
float hash13(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, vec3(p.y + 33.33, p.z + 33.33, p.x + 33.33));
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec3 p) {
  vec3 i = floor(p);
  vec3 f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float n000 = hash13(i);
  float n100 = hash13(i + vec3(1.0, 0.0, 0.0));
  float n010 = hash13(i + vec3(0.0, 1.0, 0.0));
  float n110 = hash13(i + vec3(1.0, 1.0, 0.0));
  float n001 = hash13(i + vec3(0.0, 0.0, 1.0));
  float n101 = hash13(i + vec3(1.0, 0.0, 1.0));
  float n011 = hash13(i + vec3(0.0, 1.0, 1.0));
  float n111 = hash13(i + vec3(1.0, 1.0, 1.0));
  float nx00 = mix(n000, n100, f.x);
  float nx10 = mix(n010, n110, f.x);
  float nx01 = mix(n001, n101, f.x);
  float nx11 = mix(n011, n111, f.x);
  return mix(mix(nx00, nx10, f.y), mix(nx01, nx11, f.y), f.z);
}
float fbm3(vec3 p) {
  float v = 0.0;
  float a = 0.5;
  v += a * vnoise(p); p = p * 2.02 + vec3(17.3, 5.1, 9.7); a *= 0.5;
  v += a * vnoise(p); p = p * 2.03 + vec3(3.1, 11.7, 4.4); a *= 0.5;
  v += a * vnoise(p);
  return v;
}
float ridged(vec3 p) {
  float v = 0.0;
  float a = 0.55;
  v += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
  p *= 2.07; a *= 0.48;
  v += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
  p *= 2.11; a *= 0.48;
  v += a * (1.0 - abs(vnoise(p) * 2.0 - 1.0));
  return v;
}
`

const RIM_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const RIM_FRAG = /* glsl */ `
uniform float uTime;
varying vec2 vUv;
${FOREST_NOISE_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  vec2 bearing = r > 1e-4 ? p / r : vec2(1.0, 0.0);
  float tear = 0.045 * (vnoise(vec3(bearing * 2.7, 0.31)) * 2.0 - 1.0);
  float innerR = 0.72 + tear;
  float outerR = 1.04 + tear;
  float inner = smoothstep(innerR - 0.16, innerR + 0.02, r);
  float outer = 1.0 - smoothstep(outerR - 0.06, outerR + 0.02, r);
  float band = inner * outer;
  if (band < 0.008) discard;
  float warp = fbm3(vec3(p * 2.4, uTime * 0.18)) * 0.35;
  float fil = ridged(vec3(p * 5.1 + warp, uTime * 0.42));
  float veins = smoothstep(0.58, 0.9, fil);
  float lip = exp(-abs(r - mix(innerR, outerR, 0.72)) * 28.0);
  float crawl = pow(max(0.0, sin((atan(bearing.y, bearing.x) * 3.2 + r * 9.0) - uTime * 1.7)), 10.0);
  float pulse = 0.86 + 0.14 * sin(uTime * 1.65);
  float light = band * (0.42 + veins * 0.7 + lip * 1.1 + crawl * 0.35) * pulse;
  vec3 core = vec3(0.5, 0.94, 1.0);
  vec3 edge = vec3(0.12, 0.36, 0.58);
  vec3 hot = vec3(0.82, 0.98, 1.0);
  vec3 col = mix(edge, core, clamp(veins + lip, 0.0, 1.0));
  col = mix(col, hot, clamp(lip * 0.65 + crawl * 0.4, 0.0, 1.0));
  gl_FragColor = vec4(col * pulse, clamp(light, 0.0, 1.0));
}
`

function patchPadSap(mat: THREE.MeshStandardMaterial): void {
  mat.onBeforeCompile = (shader) => {
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>
{
  float cyan = max(0.0, diffuseColor.g * 0.28 + diffuseColor.b * 0.72 - diffuseColor.r);
  totalEmissiveRadiance += vec3(0.22, 0.9, 1.0) * pow(cyan, 1.35) * 1.35;
}`
    )
  }
  mat.customProgramCacheKey = () => 'forest-landing-center-v3'
}

export function createForestRimMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: RIM_VERT,
    fragmentShader: RIM_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false
  })
}

const DISC_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`

const DISC_FRAG = /* glsl */ `
uniform float uTime;
uniform float uLive;
varying vec2 vUv;
${FOREST_NOISE_GLSL}
void main() {
  vec2 p = vUv * 2.0 - 1.0;
  float r = length(p);
  if (r > 1.02) discard;
  vec2 bearing = r > 1e-4 ? p / r : vec2(1.0, 0.0);
  float inside = 1.0 - smoothstep(0.94, 1.0, r);
  float warp = fbm3(vec3(p * 2.1, uTime * 0.14)) * 0.32;
  float fil = ridged(vec3(p * 3.6 + warp, uTime * 0.28));
  float veins = smoothstep(0.56, 0.9, fil);
  float rings = pow(max(0.0, 1.0 - abs(fract(r * 2.8 - uTime * 0.16) - 0.5) * 2.0), 16.0);
  float lip = exp(-abs(r - 0.9) * 18.0);
  float crawl = pow(max(0.0, sin(atan(bearing.y, bearing.x) * 4.0 - uTime * 1.4)), 8.0);
  float pulse = 0.9 + 0.1 * sin(uTime * 1.5);
  float live = clamp(uLive, 0.0, 1.0);
  vec3 plate = mix(vec3(0.08, 0.22, 0.28), vec3(0.14, 0.4, 0.48), live);
  vec3 core = vec3(0.4, 0.9, 1.0);
  vec3 hot = vec3(0.78, 0.97, 1.0);
  vec3 col = plate + core * (veins * 0.5 + rings * 0.35) + hot * (lip * 0.7 + crawl * 0.2);
  col *= pulse;
  float alpha = inside * mix(0.78, 0.9, live);
  gl_FragColor = vec4(col, alpha);
}
`

export function createForestPoolDiscMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uLive: { value: 0 }
    },
    vertexShader: DISC_VERT,
    fragmentShader: DISC_FRAG,
    transparent: true,
    depthWrite: true,
    depthTest: true,
    blending: THREE.NormalBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false
  })
}

const CURTAIN_VERT = /* glsl */ `
varying vec2 vUv;
varying float vH;
varying vec3 vViewN;
varying vec3 vViewPos;
void main() {
  vUv = uv;
  vH = uv.y;
  vViewN = normalize(normalMatrix * normal);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vViewPos = mv.xyz;
  gl_Position = projectionMatrix * mv;
}
`

const CURTAIN_FRAG = /* glsl */ `
uniform float uTime;
uniform float uOn;
uniform vec2 uOrigin;
varying vec2 vUv;
varying float vH;
varying vec3 vViewN;
varying vec3 vViewPos;
${FOREST_NOISE_GLSL}
void main() {
  float on = clamp(uOn, 0.0, 1.0);
  if (on < 0.01) discard;

  float h = clamp(vH, 0.0, 1.0);
  float a = vUv.x * 6.28318530718;
  vec2 ring = vec2(cos(a), sin(a));
  float seed = fract(uOrigin.x * 0.137 + uOrigin.y * 0.419);

  // Torn crown so the column does not read as a cylinder lid.
  float crown = 0.84 + 0.16 * (vnoise(vec3(ring * 2.8, seed * 6.0)) * 2.0 - 1.0);
  float topMask = 1.0 - smoothstep(crown - 0.18, crown, h);
  float env = pow(1.0 - h, 0.48) * topMask;

  float lip = exp(-h * 12.0) * (0.9 + 0.1 * sin(uTime * 2.15 + seed * 6.28));

  vec3 wp = vec3(ring * 2.05, h * 3.1 - uTime * 0.26 + seed);
  float warp = fbm3(wp) * 0.4;
  float fil = ridged(vec3(ring * 3.1 + warp, h * 4.6 - uTime * 0.58 + seed * 11.0));
  float veins = smoothstep(0.36, 0.8, fil);

  float r1 = pow(max(0.0, 1.0 - abs(fract(h * 2.15 - uTime * 0.18 + seed) - 0.5) * 2.0), 9.0);
  float r2 = pow(max(0.0, 1.0 - abs(fract(h * 1.45 + uTime * 0.11 + 0.37) - 0.5) * 2.0), 8.0) * 0.55;
  float rings = r1 + r2;

  float spokeN = vnoise(vec3(ring * 1.15, seed + 2.7));
  float spokes = pow(abs(sin(a * 4.0 + spokeN * 1.2 + uTime * 0.28)), 8.0) * 0.7;

  float embers = pow(max(0.0, vnoise(vec3(ring * 6.8, h * 8.4 + uTime * 1.25 + seed))), 5.5);

  vec3 N = normalize(vViewN);
  N *= gl_FrontFacing ? 1.0 : -1.0;
  vec3 V = normalize(-vViewPos);
  float fres = pow(1.0 - abs(dot(N, V)), 1.5);

  float pulse = 0.9 + 0.1 * sin(uTime * 1.62 + seed * 4.0);
  float pattern = 0.85 + veins * 0.55 + rings * 0.4 + spokes * 0.25 + embers * 0.2 + lip * 0.35;
  float alpha = env * on * pulse * 0.7 * pattern * (0.88 + 0.12 * fres);
  alpha = clamp(alpha, 0.0, 0.9);
  if (alpha < 0.02) discard;

  vec3 core = vec3(0.48, 0.92, 1.0);
  vec3 edge = vec3(0.1, 0.34, 0.55);
  vec3 hot = vec3(0.8, 0.97, 1.0);
  vec3 col = mix(edge, core, clamp(veins + rings * 0.6, 0.0, 1.0));
  col = mix(col, hot, clamp(lip * 0.65 + embers + rings * 0.3, 0.0, 1.0));
  gl_FragColor = vec4(col * pulse, alpha);
}
`

export function createForestCurtainMaterial(): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 },
      uOn: { value: 0 },
      uOrigin: { value: new THREE.Vector2() }
    },
    vertexShader: CURTAIN_VERT,
    fragmentShader: CURTAIN_FRAG,
    transparent: true,
    depthWrite: false,
    depthTest: true,
    blending: THREE.AdditiveBlending,
    side: THREE.DoubleSide,
    toneMapped: false,
    fog: false
  })
}

export class ForestLanding {
  private root: THREE.Object3D | null = null
  private rim: THREE.Mesh | null = null
  private rimMat: THREE.ShaderMaterial | null = null
  private disposed = false

  constructor(
    private readonly scene: THREE.Scene,
    private readonly fallback: THREE.Object3D,
    private readonly oldRim: THREE.Object3D | null
  ) {
    const loader = new GLTFLoader()
    loader.load(
      GLB_URL,
      (gltf) => {
        if (this.disposed) {
          gltf.scene.traverse((o) => {
            if (o instanceof THREE.Mesh) {
              o.geometry.dispose()
              const mats = Array.isArray(o.material) ? o.material : [o.material]
              for (const m of mats) m.dispose()
            }
          })
          return
        }
        const group = gltf.scene
        group.updateMatrixWorld(true)
        const box = new THREE.Box3().setFromObject(group)
        const size = new THREE.Vector3()
        box.getSize(size)
        const span = Math.max(size.x, size.z, 0.01)
        const scale = (FOREST_LANDING_RADIUS_M * 2) / span
        group.scale.setScalar(scale)
        group.position.set(0, 0.06 - box.max.y * scale, 0)
        group.traverse((o) => {
          if (!(o instanceof THREE.Mesh)) return
          o.castShadow = false
          o.receiveShadow = false
          const mats = Array.isArray(o.material) ? o.material : [o.material]
          for (const m of mats) {
            if (!(m instanceof THREE.MeshStandardMaterial)) continue
            m.side = THREE.DoubleSide
            m.color.set(0xffffff)
            m.emissive.set(0x2a3c44)
            m.emissiveIntensity = 0.85
            if (m.map) {
              m.map.colorSpace = THREE.SRGBColorSpace
              m.map.anisotropy = 8
            }
            patchPadSap(m)
          }
        })
        group.name = 'forest-landing-glb'
        this.scene.add(group)
        this.root = group
        this.fallback.visible = false
        this.fallback.removeFromParent()
        this.oldRim?.removeFromParent()
        this.addRimGradient()
      },
      undefined,
      () => {
        /* keep the circle fallback */
      }
    )
  }

  update(time: number): void {
    if (this.rimMat) this.rimMat.uniforms.uTime.value = time
  }

  dispose(): void {
    this.disposed = true
    this.root?.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return
      o.geometry.dispose()
      const mats = Array.isArray(o.material) ? o.material : [o.material]
      for (const m of mats) {
        if (m instanceof THREE.MeshStandardMaterial) {
          m.map?.dispose()
          m.normalMap?.dispose()
          m.metalnessMap?.dispose()
          m.roughnessMap?.dispose()
        }
        m.dispose()
      }
    })
    this.root?.removeFromParent()
    this.root = null
    this.rim?.removeFromParent()
    this.rim?.geometry.dispose()
    this.rimMat?.dispose()
    this.rim = null
    this.rimMat = null
  }

  private addRimGradient(): void {
    const geo = new THREE.CircleGeometry(FOREST_LANDING_RADIUS_M * 1.06, 80)
    geo.rotateX(-Math.PI / 2)
    this.rimMat = createForestRimMaterial()
    this.rim = new THREE.Mesh(geo, this.rimMat)
    this.rim.name = 'forest-landing-rim-gradient'
    this.rim.position.y = 0.09
    this.rim.renderOrder = 4
    this.rim.frustumCulled = false
    this.scene.add(this.rim)
  }
}
