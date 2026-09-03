/**
 * Ground veins from the landing disc out to each pool.
 * Mesh ribbons follow A* paths that walk around trees and other pools.
 */
import * as THREE from 'three'
import { FOREST_LANDING_RADIUS_M, type ForestTreePose } from './worldsForestLayout'
import { buildVeinPaths, type VeinPath, type VeinPoolInput } from './worldsForestVeinPaths'

export const FOREST_VEIN_MAX_POOLS = 256

const RING_SEGS = 96
const Y = 0.055
const Y_TREE = 0.08
const WIDTH_EMPTY = 0.2
const WIDTH_LIVE = 0.34
const WIDTH_TREE = 0.18
const WIDTH_RING = 0.26

const COL_EMPTY = new THREE.Color(0.22, 0.55, 0.62)
const COL_LIVE = new THREE.Color(0.45, 0.92, 1.0)
const COL_TREE = new THREE.Color(0.82, 0.32, 1.0)
const COL_RING = new THREE.Color(0.78, 0.95, 0.72)

const VERT = /* glsl */ `
attribute float aLive;
attribute vec3 aTint;
varying vec2 vUv;
varying vec2 vWorldXZ;
varying float vLive;
varying vec3 vTint;
attribute vec2 aDest;
varying vec2 vDest;
void main() {
  vUv = uv;
  vLive = aLive;
  vTint = aTint;
  vDest = aDest;
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorldXZ = wp.xz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`

const FRAG = /* glsl */ `
uniform float uTime;
uniform vec2 uPlayer;
uniform vec2 uFocus;
uniform float uHasFocus;
varying vec2 vUv;
varying vec2 vWorldXZ;
varying float vLive;
varying vec3 vTint;
varying vec2 vDest;
void main() {
  float edge = 1.0 - abs(vUv.y - 0.5) * 2.0;
  float core = pow(max(edge, 0.0), 1.45);
  float halo = pow(max(edge, 0.0), 0.55);
  float distHub = length(vWorldXZ);
  float distP = length(vWorldXZ - uPlayer);
  float awayFromPad = smoothstep(16.0, 28.0, distHub);
  float nearWalk = 1.0 - smoothstep(5.0, 13.0, distP);
  float isTree = step(0.1, vLive) * step(vLive, 0.7);
  float isRing = step(length(vDest), 0.8);

  // Shared outward surge: landing ring flashes, then a packet runs
  // along each vein (uv.x 0 at the circle → 1 at dest).
  float cycle = fract(uTime * 0.52);
  float launch = exp(-min(cycle, 1.0 - cycle) * 22.0);
  float head = cycle;
  float packet = pow(max(0.0, 1.0 - abs(vUv.x - head) * 7.2), 2.6);
  float behind = max(head - vUv.x, 0.0);
  float tail = pow(max(0.0, 1.0 - behind * 2.8), 1.6) * 0.4;
  float surge = isRing > 0.5 ? launch : clamp(packet + tail, 0.0, 1.0);

  float emptyVis = 0.26 + 0.14 * awayFromPad + 0.1 * nearWalk + 0.38 * surge;
  float treeVis = 0.36 + 0.1 * nearWalk + 0.58 * surge;
  float vis = vLive > 0.7 ? 0.82 + 0.4 * surge : (isTree > 0.5 ? treeVis : emptyVis);
  vis = mix(vis, 0.72 + 0.55 * launch, isRing);

  vec3 col = vTint * (0.7 + surge * 0.75);
  col *= mix(1.0, 1.08 + 0.55 * surge, isTree);
  if (uHasFocus > 0.5) {
    float match = 1.0 - smoothstep(0.6, 3.2, length(vDest - uFocus));
    vis = isRing > 0.5 ? 0.28 + 0.4 * launch : mix(0.03, 1.45, match);
    vec3 lit = vec3(0.45, 0.92, 1.0) * (0.85 + surge * 0.6);
    col = mix(col, lit, match);
    vis *= 0.75 + 0.5 * surge;
  }
  float alpha = (core * 0.95 + halo * 0.28) * vis * (0.72 + surge * 0.42);
  if (alpha < 0.015) discard;
  gl_FragColor = vec4(col, alpha);
}
`

function layoutKey(pools: VeinPoolInput[], trees: ForestTreePose[]): string {
  let s = `${pools.length}:${trees.length}`
  for (const p of pools) s += `|${p.x.toFixed(1)},${p.z.toFixed(1)},${p.radius.toFixed(1)}`
  for (const t of trees) s += `|t${t.x.toFixed(1)},${t.z.toFixed(1)}`
  return s
}

function landingRingPoints(): Array<{ x: number; z: number }> {
  const pts: Array<{ x: number; z: number }> = []
  for (let i = 0; i <= RING_SEGS; i++) {
    const a = (i / RING_SEGS) * Math.PI * 2
    pts.push({
      x: Math.cos(a) * FOREST_LANDING_RADIUS_M,
      z: Math.sin(a) * FOREST_LANDING_RADIUS_M
    })
  }
  return pts
}

function addStrip(
  pts: Array<{ x: number; z: number }>,
  halfW: number,
  live: number,
  tint: THREE.Color,
  positions: number[],
  uvs: number[],
  lives: number[],
  tints: number[],
  dests: number[],
  destX: number,
  destZ: number,
  indices: number[],
  y = Y
): void {
  if (pts.length < 2) return
  const base = positions.length / 3
  const n = pts.length
  let acc = 0
  const segLen: number[] = [0]
  for (let i = 1; i < n; i++) {
    acc += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.z - pts[i - 1]!.z)
    segLen.push(acc)
  }
  const total = Math.max(acc, 1e-4)

  for (let i = 0; i < n; i++) {
    const prev = pts[i === 0 ? 0 : i - 1]!
    const next = pts[i === n - 1 ? n - 1 : i + 1]!
    let tx = next.x - prev.x
    let tz = next.z - prev.z
    const len = Math.hypot(tx, tz) || 1
    tx /= len
    tz /= len
    const px = -tz * halfW
    const pz = tx * halfW
    const p = pts[i]!
    const u = segLen[i]! / total
    positions.push(p.x + px, y, p.z + pz, p.x - px, y, p.z - pz)
    uvs.push(u, 0, u, 1)
    lives.push(live, live)
    tints.push(tint.r, tint.g, tint.b, tint.r, tint.g, tint.b)
    dests.push(destX, destZ, destX, destZ)
  }

  for (let i = 0; i < n - 1; i++) {
    const a = base + i * 2
    const b = a + 1
    const c = a + 2
    const d = a + 3
    indices.push(a, c, b, b, c, d)
  }
}

function buildGeometry(paths: VeinPath[], focus: { x: number; z: number } | null): THREE.BufferGeometry {
  const positions: number[] = []
  const uvs: number[] = []
  const lives: number[] = []
  const tints: number[] = []
  const dests: number[] = []
  const indices: number[] = []

  addStrip(landingRingPoints(), WIDTH_RING, 1, COL_RING, positions, uvs, lives, tints, dests, 0, 0, indices)
  for (const path of paths) {
    const focused =
      !!focus && path.kind === 'pool' && Math.hypot(path.destX - focus.x, path.destZ - focus.z) < 3.2
    const tree = path.kind === 'tree'
    const tint = focused ? COL_LIVE : tree ? COL_TREE : path.live ? COL_LIVE : COL_EMPTY
    const w = focused ? WIDTH_LIVE : tree ? WIDTH_TREE : path.live ? WIDTH_LIVE : WIDTH_EMPTY
    const glow = focused ? 1 : tree ? 0.42 : path.live ? 1 : 0
    addStrip(
      path.points,
      w,
      glow,
      tint,
      positions,
      uvs,
      lives,
      tints,
      dests,
      path.destX,
      path.destZ,
      indices,
      tree ? Y_TREE : Y
    )
  }

  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2))
  geo.setAttribute('aLive', new THREE.Float32BufferAttribute(lives, 1))
  geo.setAttribute('aTint', new THREE.Float32BufferAttribute(tints, 3))
  geo.setAttribute('aDest', new THREE.Float32BufferAttribute(dests, 2))
  geo.setIndex(indices)
  geo.computeBoundingSphere()
  return geo
}

const MOTE_PER_M = 0.55
const MOTE_MIN = 10
const MOTE_MAX = 34
const MOTE_Y0 = 0.04
const MOTE_Y1 = 0.5
const MOTE_SIDE = 0.12

type PackedPath = {
  xs: Float32Array
  zs: Float32Array
  cum: Float32Array
  total: number
}

function packPath(points: Array<{ x: number; z: number }>): PackedPath | null {
  if (points.length < 2) return null
  const n = points.length
  const xs = new Float32Array(n)
  const zs = new Float32Array(n)
  const cum = new Float32Array(n)
  let acc = 0
  for (let i = 0; i < n; i++) {
    xs[i] = points[i]!.x
    zs[i] = points[i]!.z
    if (i > 0) acc += Math.hypot(xs[i]! - xs[i - 1]!, zs[i]! - zs[i - 1]!)
    cum[i] = acc
  }
  if (acc < 1.2) return null
  return { xs, zs, cum, total: acc }
}

function samplePacked(
  path: PackedPath,
  dist: number
): { x: number; z: number; tx: number; tz: number } {
  const d = Math.max(0, Math.min(path.total, dist))
  const n = path.cum.length
  let i = 1
  while (i < n - 1 && path.cum[i]! < d) i++
  const a = i - 1
  const span = Math.max(1e-4, path.cum[i]! - path.cum[a]!)
  const t = (d - path.cum[a]!) / span
  const ax = path.xs[a]!
  const az = path.zs[a]!
  const bx = path.xs[i]!
  const bz = path.zs[i]!
  let tx = bx - ax
  let tz = bz - az
  const len = Math.hypot(tx, tz) || 1
  tx /= len
  tz /= len
  return { x: ax + (bx - ax) * t, z: az + (bz - az) * t, tx, tz }
}

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

function moteCountFor(length: number): number {
  return Math.max(MOTE_MIN, Math.min(MOTE_MAX, Math.round(length * MOTE_PER_M)))
}

export class ForestVeins {
  readonly mesh: THREE.Mesh
  private readonly material: THREE.ShaderMaterial
  private readonly motes: THREE.Points
  private readonly moteMat: THREE.PointsMaterial
  private readonly moteTex: THREE.Texture
  private posKey = ''
  private paths: VeinPath[] = []
  private focus: { x: number; z: number } | null = null
  private motePaths: PackedPath[] = []
  private motePathIdx = new Uint16Array(0)
  private moteAlong = new Float32Array(0)
  private moteSide = new Float32Array(0)
  private moteAge = new Float32Array(0)
  private moteLife = new Float32Array(0)
  private moteSpeed = new Float32Array(0)
  private moteCount = 0

  constructor(scene: THREE.Scene) {
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        uTime: { value: 0 },
        uPlayer: { value: new THREE.Vector2(0, 0) },
        uFocus: { value: new THREE.Vector2(0, 0) },
        uHasFocus: { value: 0 }
      },
      vertexShader: VERT,
      fragmentShader: FRAG,
      fog: false,
      toneMapped: false,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      side: THREE.DoubleSide
    })
    this.mesh = new THREE.Mesh(buildGeometry([], null), this.material)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 1
    scene.add(this.mesh)

    this.moteTex = makeSparkTexture()
    this.moteMat = new THREE.PointsMaterial({
      map: this.moteTex,
      color: 0xb8f4ff,
      size: 0.3,
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.92,
      depthWrite: false,
      blending: THREE.AdditiveBlending
    })
    this.motes = new THREE.Points(new THREE.BufferGeometry(), this.moteMat)
    this.motes.frustumCulled = false
    this.motes.renderOrder = 2
    this.motes.visible = false
    scene.add(this.motes)
  }

  setLayout(pools: VeinPoolInput[], trees: ForestTreePose[]): void {
    const capped = pools.slice(0, FOREST_VEIN_MAX_POOLS)
    const key = layoutKey(capped, trees)
    if (key !== this.posKey) {
      this.posKey = key
      try {
        this.paths = buildVeinPaths(capped, trees)
      } catch (err) {
        console.warn('[forest-veins] path build failed', err)
        this.paths = []
      }
    } else {
      for (const path of this.paths) {
        if (path.kind !== 'pool') continue
        const match = capped.find(
          (p) => Math.abs(p.x - path.destX) < 0.05 && Math.abs(p.z - path.destZ) < 0.05
        )
        if (match) path.live = match.live
      }
    }
    this.applyGeometry()
    this.rebuildMotes()
  }

  setFocus(x: number | null, z: number | null): void {
    const on = x != null && z != null && Number.isFinite(x) && Number.isFinite(z)
    this.focus = on ? { x, z } : null
    this.material.uniforms.uHasFocus.value = on ? 1 : 0
    if (on) (this.material.uniforms.uFocus.value as THREE.Vector2).set(x, z)
    this.applyGeometry()
    this.rebuildMotes()
  }

  private applyGeometry(): void {
    const old = this.mesh.geometry
    this.mesh.geometry = buildGeometry(this.paths, this.focus)
    old.dispose()
  }

  update(time: number, playerX: number, playerZ: number, dt = 0): void {
    this.material.uniforms.uTime.value = time
    const player = this.material.uniforms.uPlayer.value as THREE.Vector2
    player.set(playerX, playerZ)
    this.stepMotes(dt)
  }

  dispose(): void {
    this.mesh.removeFromParent()
    this.mesh.geometry.dispose()
    this.material.dispose()
    this.motes.removeFromParent()
    this.motes.geometry.dispose()
    this.moteMat.dispose()
    this.moteTex.dispose()
  }

  private rebuildMotes(): void {
    const packed: PackedPath[] = []
    const counts: number[] = []
    let total = 0
    const hasFocus = (this.material.uniforms.uHasFocus.value as number) > 0.5
    const focus = this.material.uniforms.uFocus.value as THREE.Vector2
    for (const path of this.paths) {
      if (hasFocus) {
        if (path.kind !== 'pool') continue
        if (Math.hypot(path.destX - focus.x, path.destZ - focus.y) > 6) continue
      } else if (!path.live) continue
      const p = packPath(path.points)
      if (!p) continue
      const n = moteCountFor(p.total)
      packed.push(p)
      counts.push(n)
      total += n
    }
    this.motePaths = packed
    this.moteCount = total
    const oldGeo = this.motes.geometry
    const geo = new THREE.BufferGeometry()
    this.motes.geometry = geo
    oldGeo.dispose()
    if (!total) {
      this.motes.visible = false
      this.motePathIdx = new Uint16Array(0)
      this.moteAlong = new Float32Array(0)
      this.moteSide = new Float32Array(0)
      this.moteAge = new Float32Array(0)
      this.moteLife = new Float32Array(0)
      this.moteSpeed = new Float32Array(0)
      return
    }

    this.motePathIdx = new Uint16Array(total)
    this.moteAlong = new Float32Array(total)
    this.moteSide = new Float32Array(total)
    this.moteAge = new Float32Array(total)
    this.moteLife = new Float32Array(total)
    this.moteSpeed = new Float32Array(total)
    const positions = new Float32Array(total * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3))

    let i = 0
    for (let p = 0; p < packed.length; p++) {
      const n = counts[p]!
      for (let k = 0; k < n; k++, i++) this.motePathIdx[i] = p
    }
    for (let m = 0; m < total; m++) this.spawnMote(m, true, positions)
    const attr = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute
    attr.needsUpdate = true
    this.motes.visible = true
  }

  private spawnMote(i: number, scatter: boolean, arr: Float32Array): void {
    const path = this.motePaths[this.motePathIdx[i]!]
    if (!path) return
    const life = 1.05 + Math.random() * 1.15
    this.moteLife[i] = life
    this.moteAge[i] = scatter ? Math.random() * life : 0
    this.moteAlong[i] = Math.random() * path.total
    this.moteSide[i] = (Math.random() * 2 - 1) * MOTE_SIDE
    this.moteSpeed[i] = 0.45 + Math.random() * 0.7
    this.writeMote(i, arr)
  }

  private writeMote(i: number, arr: Float32Array): void {
    const path = this.motePaths[this.motePathIdx[i]!]
    if (!path) return
    const along = ((this.moteAlong[i]! % path.total) + path.total) % path.total
    const s = samplePacked(path, along)
    const t = Math.min(1, this.moteAge[i]! / Math.max(this.moteLife[i]!, 1e-4))
    arr[i * 3] = s.x + -s.tz * this.moteSide[i]!
    arr[i * 3 + 1] = MOTE_Y0 + (MOTE_Y1 - MOTE_Y0) * t
    arr[i * 3 + 2] = s.z + s.tx * this.moteSide[i]!
  }

  private stepMotes(dt: number): void {
    if (!this.moteCount || dt <= 0) return
    const attr = this.motes.geometry.getAttribute('position') as THREE.BufferAttribute | undefined
    if (!attr) return
    const arr = attr.array as Float32Array
    for (let i = 0; i < this.moteCount; i++) {
      this.moteAge[i]! += dt
      if (this.moteAge[i]! >= this.moteLife[i]!) {
        this.spawnMote(i, false, arr)
        continue
      }
      this.moteAlong[i]! += this.moteSpeed[i]! * dt
      this.writeMote(i, arr)
    }
    attr.needsUpdate = true
  }
}
