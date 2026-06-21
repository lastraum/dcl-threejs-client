import * as THREE from 'three'
import { PSB_ADD, PSB_MULTIPLY, TFM_POINT, TFM_TRILINEAR, TWM_MIRROR, TWM_REPEAT } from './constants'
import type { LiveParticle, ParticleBuffers, ParticleSpec } from './types'

function wrapMode(mode?: number): THREE.Wrapping {
  if (mode === TWM_REPEAT) return THREE.RepeatWrapping
  if (mode === TWM_MIRROR) return THREE.MirroredRepeatWrapping
  return THREE.ClampToEdgeWrapping
}

function blendModeToThree(mode?: number): THREE.Blending {
  if (mode === PSB_ADD) return THREE.AdditiveBlending
  if (mode === PSB_MULTIPLY) return THREE.MultiplyBlending
  return THREE.NormalBlending
}

const VERTEX_SHADER = /* glsl */ `
attribute vec3 instancePosition;
attribute vec4 instanceColor;
attribute float instanceSize;
attribute vec3 instanceRotation;
attribute float instanceFrame;
attribute vec3 instanceVelocity;

uniform float uBillboard;
uniform float uFaceTravel;

varying vec4 vColor;
varying vec2 vUv;
varying float vFrame;

mat3 rotationZ(float a) {
  float s = sin(a);
  float c = cos(a);
  return mat3(c, -s, 0.0, s, c, 0.0, 0.0, 0.0, 1.0);
}

mat3 rotationEuler(vec3 euler) {
  float cx = cos(euler.x);
  float sx = sin(euler.x);
  float cy = cos(euler.y);
  float sy = sin(euler.y);
  float cz = cos(euler.z);
  float sz = sin(euler.z);
  mat3 rx = mat3(1.0, 0.0, 0.0, 0.0, cx, -sx, 0.0, sx, cx);
  mat3 ry = mat3(cy, 0.0, sy, 0.0, 1.0, 0.0, -sy, 0.0, cy);
  mat3 rz = mat3(cz, -sz, 0.0, sz, cz, 0.0, 0.0, 0.0, 1.0);
  return rz * ry * rx;
}

void main() {
  vColor = instanceColor;
  vUv = uv;
  vFrame = instanceFrame;

  vec3 corner = vec3(position.xy * instanceSize, 0.0);
  vec3 center = instancePosition;
  vec3 transformed = corner;

  if (uFaceTravel > 0.5) {
    vec3 vel = instanceVelocity;
    float len = length(vel);
    if (len > 0.0001) {
      vec3 forward = normalize(vel);
      vec3 worldUp = vec3(0.0, 1.0, 0.0);
      vec3 right = normalize(cross(worldUp, forward));
      if (length(right) < 0.001) right = vec3(1.0, 0.0, 0.0);
      vec3 up = cross(forward, right);
      mat3 basis = mat3(right, up, forward);
      transformed = basis * corner;
    }
  } else if (uBillboard > 0.5) {
    vec4 mvCenter = modelViewMatrix * vec4(center, 1.0);
    float spin = instanceRotation.z;
    vec2 rotated = (rotationZ(spin) * vec3(corner.xy, 0.0)).xy;
    vec4 mv = mvCenter + vec4(rotated, 0.0, 0.0);
    gl_Position = projectionMatrix * mv;
    return;
  } else {
    transformed = rotationEuler(instanceRotation) * corner;
  }

  vec4 mvPosition = modelViewMatrix * vec4(center + transformed, 1.0);
  gl_Position = projectionMatrix * mvPosition;
}
`

const FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
uniform vec2 uTiles;
uniform float uUseMap;
uniform float uAlphaTest;

varying vec4 vColor;
varying vec2 vUv;
varying float vFrame;

void main() {
  vec4 color = vColor;
  if (uUseMap > 0.5) {
    float total = max(1.0, uTiles.x * uTiles.y);
    float frame = mod(floor(vFrame + 0.5), total);
    float col = mod(frame, uTiles.x);
    float row = floor(frame / uTiles.x);
    vec2 sheetUv = (vec2(col, row) + vUv) / uTiles;
    vec4 tex = texture2D(map, sheetUv);
    color *= tex;
  }
  if (color.a < uAlphaTest) discard;
  gl_FragColor = color;
}
`

export type ParticleGpuMesh = {
  mesh: THREE.Mesh
  geometry: THREE.InstancedBufferGeometry
  material: THREE.ShaderMaterial
  buffers: ParticleBuffers
  attrPosition: THREE.InstancedBufferAttribute
  attrColor: THREE.InstancedBufferAttribute
  attrSize: THREE.InstancedBufferAttribute
  attrRotation: THREE.InstancedBufferAttribute
  attrFrame: THREE.InstancedBufferAttribute
  attrVelocity: THREE.InstancedBufferAttribute
}

export function createParticleBuffers(capacity: number): ParticleBuffers {
  return {
    positions: new Float32Array(capacity * 3),
    colors: new Float32Array(capacity * 4),
    sizes: new Float32Array(capacity),
    rotations: new Float32Array(capacity * 3),
    frames: new Float32Array(capacity),
    velocities: new Float32Array(capacity * 3),
    capacity
  }
}

export function createParticleGpuMesh(capacity: number, spec: ParticleSpec): ParticleGpuMesh {
  const base = new THREE.PlaneGeometry(1, 1)
  const geometry = new THREE.InstancedBufferGeometry()
  geometry.index = base.index
  geometry.attributes.position = base.attributes.position
  geometry.attributes.normal = base.attributes.normal
  geometry.attributes.uv = base.attributes.uv

  const buffers = createParticleBuffers(capacity)
  const attrPosition = new THREE.InstancedBufferAttribute(buffers.positions, 3)
  const attrColor = new THREE.InstancedBufferAttribute(buffers.colors, 4)
  const attrSize = new THREE.InstancedBufferAttribute(buffers.sizes, 1)
  const attrRotation = new THREE.InstancedBufferAttribute(buffers.rotations, 3)
  const attrFrame = new THREE.InstancedBufferAttribute(buffers.frames, 1)
  const attrVelocity = new THREE.InstancedBufferAttribute(buffers.velocities, 3)

  for (const attr of [attrPosition, attrColor, attrSize, attrRotation, attrFrame, attrVelocity]) {
    attr.setUsage(THREE.DynamicDrawUsage)
  }

  geometry.setAttribute('instancePosition', attrPosition)
  geometry.setAttribute('instanceColor', attrColor)
  geometry.setAttribute('instanceSize', attrSize)
  geometry.setAttribute('instanceRotation', attrRotation)
  geometry.setAttribute('instanceFrame', attrFrame)
  geometry.setAttribute('instanceVelocity', attrVelocity)

  const tilesX = spec.spriteSheet?.tilesX ?? 1
  const tilesY = spec.spriteSheet?.tilesY ?? 1
  const faceTravel = spec.faceTravelDirection === true
  const billboard = !faceTravel && spec.billboard !== false

  const material = new THREE.ShaderMaterial({
    uniforms: {
      map: { value: null as THREE.Texture | null },
      uTiles: { value: new THREE.Vector2(Math.max(1, tilesX), Math.max(1, tilesY)) },
      uUseMap: { value: 0 },
      uAlphaTest: { value: 0.01 },
      uBillboard: { value: billboard ? 1 : 0 },
      uFaceTravel: { value: faceTravel ? 1 : 0 }
    },
    vertexShader: VERTEX_SHADER,
    fragmentShader: FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    blending: blendModeToThree(spec.blendMode),
    vertexColors: false
  })

  const mesh = new THREE.Mesh(geometry, material)
  mesh.frustumCulled = false
  geometry.instanceCount = 0

  return {
    mesh,
    geometry,
    material,
    buffers,
    attrPosition,
    attrColor,
    attrSize,
    attrRotation,
    attrFrame,
    attrVelocity
  }
}

export function applyParticleTexture(
  gpu: ParticleGpuMesh,
  texture: THREE.Texture | null,
  spec: ParticleSpec
): void {
  if (!texture) {
    gpu.material.uniforms.uUseMap!.value = 0
    return
  }
  texture.wrapS = wrapMode(spec.texture?.wrapMode)
  texture.wrapT = wrapMode(spec.texture?.wrapMode)
  texture.minFilter =
    spec.texture?.filterMode === TFM_POINT
      ? THREE.NearestFilter
      : spec.texture?.filterMode === TFM_TRILINEAR
        ? THREE.LinearMipmapLinearFilter
        : THREE.LinearFilter
  texture.magFilter = spec.texture?.filterMode === TFM_POINT ? THREE.NearestFilter : THREE.LinearFilter
  texture.colorSpace = THREE.SRGBColorSpace
  gpu.material.uniforms.map!.value = texture
  gpu.material.uniforms.uUseMap!.value = 1
}

export function updateParticleGpuUniforms(gpu: ParticleGpuMesh, spec: ParticleSpec): void {
  const tilesX = spec.spriteSheet?.tilesX ?? 1
  const tilesY = spec.spriteSheet?.tilesY ?? 1
  const faceTravel = spec.faceTravelDirection === true
  const billboard = !faceTravel && spec.billboard !== false
  ;(gpu.material.uniforms.uTiles!.value as THREE.Vector2).set(Math.max(1, tilesX), Math.max(1, tilesY))
  gpu.material.uniforms.uBillboard!.value = billboard ? 1 : 0
  gpu.material.uniforms.uFaceTravel!.value = faceTravel ? 1 : 0
  gpu.material.blending = blendModeToThree(spec.blendMode)
}

const _localPos = new THREE.Vector3()
const _scratchColor = new THREE.Color()

export function uploadParticlesToGpu(
  gpu: ParticleGpuMesh,
  live: LiveParticle[],
  spec: ParticleSpec,
  worldSpace: boolean,
  invParent: THREE.Matrix4 | null
): void {
  const count = live.length
  const { buffers, attrPosition, attrColor, attrSize, attrRotation, attrFrame, attrVelocity } = gpu

  const sheet = spec.spriteSheet
  const totalFrames = Math.max(1, (sheet?.tilesX ?? 1) * (sheet?.tilesY ?? 1))
  const fps = sheet?.framesPerSecond ?? 30

  for (let i = 0; i < count; i++) {
    const p = live[i]!
    const t = Math.min(1, p.age / p.lifetime)

    if (worldSpace && invParent) {
      _localPos.copy(p.position).applyMatrix4(invParent)
    } else {
      _localPos.copy(p.position)
    }

    buffers.positions[i * 3] = _localPos.x
    buffers.positions[i * 3 + 1] = _localPos.y
    buffers.positions[i * 3 + 2] = _localPos.z

    _scratchColor.copy(p.startColor).lerp(p.endColor, t)
    const alpha = p.startAlpha + (p.endAlpha - p.startAlpha) * t
    buffers.colors[i * 4] = _scratchColor.r
    buffers.colors[i * 4 + 1] = _scratchColor.g
    buffers.colors[i * 4 + 2] = _scratchColor.b
    buffers.colors[i * 4 + 3] = Math.max(0, alpha)

    const size = p.startSize + (p.endSize - p.startSize) * t
    buffers.sizes[i] = Math.max(0.001, size)

    if (spec.faceTravelDirection) {
      buffers.rotations[i * 3] = 0
      buffers.rotations[i * 3 + 1] = 0
      buffers.rotations[i * 3 + 2] = 0
    } else if (spec.billboard !== false) {
      buffers.rotations[i * 3] = 0
      buffers.rotations[i * 3 + 1] = 0
      buffers.rotations[i * 3 + 2] = p.rotation.z
    } else {
      buffers.rotations[i * 3] = p.rotation.x
      buffers.rotations[i * 3 + 1] = p.rotation.y
      buffers.rotations[i * 3 + 2] = p.rotation.z
    }

    buffers.frames[i] = sheet ? Math.floor(p.age * fps) % totalFrames : 0

    buffers.velocities[i * 3] = p.velocity.x
    buffers.velocities[i * 3 + 1] = p.velocity.y
    buffers.velocities[i * 3 + 2] = p.velocity.z
  }

  gpu.geometry.instanceCount = count
  attrPosition.needsUpdate = true
  attrColor.needsUpdate = true
  attrSize.needsUpdate = true
  attrRotation.needsUpdate = true
  attrFrame.needsUpdate = true
  attrVelocity.needsUpdate = true
}

export function disposeParticleGpuMesh(gpu: ParticleGpuMesh): void {
  gpu.geometry.dispose()
  gpu.material.dispose()
}