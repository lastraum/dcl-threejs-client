/**
 * Cyan runic seal for forest Jump In — GroundField(RUNE) from threejs-vfx
 * (vfx.lastslice.co), recolored off the amber/orange palette.
 */
import * as THREE from 'three'
import { GroundField, GroundMode, groundFieldParams } from '@vfx/vfx/GroundField.js'
import { Tube, TubePath } from '@vfx/vfx/Tube.js'
import { Shell, ShellMode } from '@vfx/vfx/Shell.js'
import { runeseal } from '@vfx/config/abilities/runeseal.js'
import { globals } from '@vfx/config/globals.js'
import { frame } from '@vfx/core/FrameUniforms.js'

const INSCRIBE = 1.25
const IGNITE = 0.55
const DISCHARGE = 0.95
const HOLD = 2.35
const FADE = 0.7
const HIDE_AT = INSCRIBE + IGNITE * 0.25
const DONE_AT = INSCRIBE + IGNITE + DISCHARGE
/** Time the ritual stays on-screen before Jump In may show the loading overlay. */
export const FOREST_RUNE_WATCH_MS = Math.ceil((DONE_AT + HOLD + FADE * 0.4) * 1000)

const CYAN_INK = '#7af0ff'
const CYAN_RULE = '#e8fdff'
const CYAN_FIRE = '#3ec8e0'
const CYAN_CHAR = '#041820'

const SEAL_FX = {
  ...runeseal,
  colorInk: CYAN_INK,
  colorRule: CYAN_RULE,
  colorFire: CYAN_FIRE,
  colorChar: CYAN_CHAR,
  columnHeight: 100,
  columnColorCore: '#f7feff',
  columnColorInner: '#7af0ff',
  columnColorOuter: '#3ec8e0',
  columnColorHalo: '#073048',
  waveColorBody: '#0c3040',
  waveColorRim: '#7af0ff',
  waveColorEdge: '#e8fdff'
}

function saturate(x: number): number {
  return Math.min(1, Math.max(0, x))
}

function easeOutCubic(t: number): number {
  const x = saturate(t)
  return 1 - (1 - x) ** 3
}

function worldLayer(root: THREE.Object3D): void {
  root.traverse((node) => node.layers.set(0))
}

let farDepth: THREE.DataTexture | null = null
function farDepthTexture(): THREE.DataTexture {
  if (!farDepth) {
    farDepth = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, THREE.RGBAFormat)
    farDepth.needsUpdate = true
  }
  return farDepth
}

export type ForestRuneSealOpts = {
  x: number
  z: number
  yaw: number
  radius: number
  onBurst?: () => void
}

export class ForestRuneSeal {
  private readonly field: InstanceType<typeof GroundField>
  private readonly column: InstanceType<typeof Tube>
  private readonly wave: InstanceType<typeof Shell>
  private readonly fx = { ...SEAL_FX }
  private readonly params = groundFieldParams()
  private readonly centre = new THREE.Vector3()
  private readonly light: THREE.PointLight
  private readonly tubeState = {
    origin: new THREE.Vector3(),
    target: new THREE.Vector3(),
    side: new THREE.Vector3(1, 0, 0),
    progress: 1,
    fade: 0,
    widthFade: 1,
    seed: 0,
    time: 0
  }
  private readonly waveState = {
    origin: new THREE.Vector3(),
    axis: new THREE.Vector3(0, 1, 0),
    side: new THREE.Vector3(1, 0, 0),
    span: 1,
    t: 0,
    fade: 0,
    seed: 0
  }
  private age = 0
  private burstFired = false
  private done = false
  private seed = Math.random() * 1000
  private radius = 3.6
  private yaw = 0
  private onBurst: (() => void) | null = null
  private warmed = false

  constructor(scene: THREE.Scene) {
    this.field = new GroundField(scene, {
      mode: GroundMode.RUNE,
      additive: false,
      layer: 0,
      name: 'forest-rune-seal'
    })
    this.field.setVisible(false)
    this.light = new THREE.PointLight(0x7af0ff, 0, 18, 2)
    this.light.position.y = 1.4
    this.light.visible = true
    scene.add(this.light)

    this.column = new Tube({
      path: TubePath.STRAIGHT,
      prefix: 'column',
      nodes: 72,
      sides: 26,
      renderOrder: 12
    })
    worldLayer(this.column.group)
    this.column.visible = false
    scene.add(this.column.group)

    this.wave = new Shell({
      mode: ShellMode.PRESSURE,
      prefix: 'wave',
      nodes: 40,
      sides: 48,
      renderOrder: 13
    })
    worldLayer(this.wave.group)
    this.wave.visible = false
    scene.add(this.wave.group)

    this.done = true
    if (!frame.uSceneDepth.value) frame.uSceneDepth.value = farDepthTexture()
  }

  /**
   * Compile the RUNE program (and the column) against the live forest lights /
   * fog so Jump In does not hitch on first present.
   */
  async prewarm(
    renderer: THREE.WebGLRenderer,
    camera: THREE.Camera,
    scene: THREE.Scene
  ): Promise<void> {
    if (this.warmed) return
    if (!frame.uSceneDepth.value) frame.uSceneDepth.value = farDepthTexture()
    this.setFieldFade(0)
    this.field.setVisible(true)
    this.column.visible = true
    this.wave.visible = true
    try {
      const compileAsync = renderer.compileAsync?.bind(renderer)
      const roots = [this.field.object3D, this.column.group, this.wave.group]
      if (compileAsync) {
        await Promise.race([
          Promise.all(roots.map((root) => compileAsync(root, camera, scene))),
          new Promise<void>((resolve) => window.setTimeout(resolve, 8000))
        ])
      } else {
        for (const root of roots) renderer.compile(root, camera, scene)
      }
      renderer.render(scene, camera)
    } catch {
      /* first Jump In still compiles if this program is skipped */
    }
    this.field.setVisible(false)
    this.column.visible = false
    this.wave.visible = false
    this.warmed = true
  }

  play(opts: ForestRuneSealOpts): Promise<void> {
    this.age = 0
    this.done = false
    this.burstFired = false
    this.seed = Math.random() * 1000
    this.radius = Math.max(2.4, opts.radius)
    this.yaw = opts.yaw
    this.centre.set(opts.x, 0, opts.z)
    this.onBurst = opts.onBurst ?? null
    this.light.position.set(opts.x, 1.4, opts.z)
    this.column.visible = false
    this.wave.visible = false
    if (!frame.uSceneDepth.value) frame.uSceneDepth.value = farDepthTexture()
    // Write a blank seal *before* showing — GroundField defaults to inscribe=1.
    this.writeField(0, 0, 0, 1)
    this.field.setVisible(true)
    return new Promise((resolve) => {
      const fail = window.setTimeout(() => this.finish(), FOREST_RUNE_WATCH_MS + 2500)
      const wait = () => {
        if (this.done) {
          window.clearTimeout(fail)
          resolve()
        } else requestAnimationFrame(wait)
      }
      wait()
    })
  }

  update(dt: number, time: number, resolution: THREE.Vector2, camera: THREE.Camera): void {
    frame.uTime.value = time
    frame.uDelta.value = dt
    frame.uResolution.value.copy(resolution)
    if (camera instanceof THREE.PerspectiveCamera) {
      frame.uCameraNear.value = camera.near
      frame.uCameraFar.value = camera.far
    }
    frame.uLightDir.value.set(0.35, 0.82, 0.45).normalize()
    frame.uShaderIntensity.value = 1.15
    frame.uGlobalGlow.value = 1.1

    if (this.done) return
    this.age += dt
    const inscribe = saturate(this.age / INSCRIBE)
    const ignite = saturate((this.age - INSCRIBE) / IGNITE)
    const discharge = saturate((this.age - INSCRIBE - IGNITE) / DISCHARGE)
    const fade =
      this.age < DONE_AT + HOLD ? 1 : 1 - saturate((this.age - DONE_AT - HOLD) / FADE)

    if (!this.burstFired && this.age >= HIDE_AT) {
      this.burstFired = true
      this.onBurst?.()
    }

    this.writeField(inscribe, ignite, discharge, fade)
    this.syncDischarge(discharge, fade)

    const lit = ignite * 2.8 + discharge * 4.5
    this.light.intensity = lit * fade
    this.light.distance = 10 + this.radius * 2
    this.light.position.set(
      this.centre.x,
      1.4 + this.fx.columnHeight * 0.35 * discharge * fade,
      this.centre.z
    )

    if (this.age >= DONE_AT + HOLD + FADE * 0.35) this.finish()
  }

  dispose(): void {
    this.finish()
    this.field.dispose()
    this.column.dispose()
    this.wave.dispose()
    this.light.removeFromParent()
    this.light.dispose()
  }

  private finish(): void {
    if (this.done) return
    this.done = true
    this.column.visible = false
    this.wave.visible = false
    this.light.intensity = 0
    this.field.setVisible(false)
  }

  private setFieldFade(fade: number): void {
    const mat = this.field.object3D.material
    if (mat instanceof THREE.ShaderMaterial && mat.uniforms.uFade) {
      mat.uniforms.uFade.value = fade
    }
  }

  private writeField(inscribe: number, ignite: number, discharge: number, fade: number): void {
    const p = this.params
    p.centre = this.centre
    p.yaw = this.yaw
    p.height = 0.06
    p.radius = this.radius
    p.grow = saturate(inscribe / 0.28)
    p.recede = 0
    p.inscribe = inscribe
    p.ignite = ignite
    p.scorch = discharge * 0.4
    p.fade = fade
    p.seed = this.seed
    p.edge = 0.5
    p.ragged = 0.05
    p.raggedScale = 0.55
    p.warp = 0.35
    p.relief = 0.85
    p.ambient = 0.26
    p.wrap = 0.4
    p.specular = 0.55
    p.gloss = 30
    p.depth = 0.05
    p.thickness = 0.03
    p.rings = 3
    p.ringInner = 0.34
    p.glyphSize = Math.min(0.5, Math.max(0.32, this.radius * 0.11))
    p.glyphStroke = 0.036
    p.glyphGap = 1.3
    p.spin = 0.14
    p.spinFalloff = 0.55
    p.rule = 0.011
    p.armStart = 0.5
    p.armRadius = 0.68
    p.armSides = 7
    p.armTangent = 0.36
    p.armStroke = 0.019
    p.armPhase = 0.35 + this.seed
    p.armSpin = -0.05
    p.tickCount = 64
    p.tickRadius = 0.955
    p.tickLength = 0.13
    p.tickStroke = 0.011
    p.tickMajor = 8
    p.tickMajorLen = 0.16
    p.sigilStart = 0.72
    p.sigilRadius = Math.min(0.42, this.radius * 0.1)
    p.sigilSize = Math.min(0.82, this.radius * 0.18)
    p.sigilArms = 5
    p.sigilStroke = 0.034
    p.sigilRing = 0.98
    p.sigilSpin = 0.07
    p.additive = false
    p.emissive = 1.45
    p.opacity = 1
    p.depthFade = 8
    p.colorBase = CYAN_INK
    p.colorEdge = CYAN_RULE
    p.colorGlow = CYAN_FIRE
    p.colorDeep = CYAN_CHAR
    p.noiseStrength = 1
    p.noiseFrequency = 1
    p.noiseSpeed = 1
    p.opacityScale = 1
    this.field.update(p)
  }

  private syncDischarge(discharge: number, fade: number): void {
    const c = this.fx
    c.waveRadius = this.radius * 0.12
    c.waveRadiusEnd = this.radius * 2.8
    const dischargeAge = Math.max(0, this.age - INSCRIBE - IGNITE)
    const rise = easeOutCubic(saturate(dischargeAge / Math.max(0.01, c.columnRise)))
    const collapse = 1 - discharge ** Math.max(0.2, c.columnCollapse)
    const fired = discharge > 0.002

    const t = this.tubeState
    t.origin.copy(this.centre)
    t.origin.y = 0.06
    t.target.copy(this.centre)
    t.target.y = 0.06 + Math.max(0.05, c.columnHeight) * rise
    t.side.set(1, 0, 0)
    t.progress = 1
    t.fade = fired ? fade * collapse : 0
    t.widthFade = 1 - discharge ** 1.6 * 0.85
    t.seed = this.seed
    t.time = Math.max(0, this.age - INSCRIBE - IGNITE)
    this.column.sync(c, t, globals)
    this.column.visible = t.fade > 0.002

    const w = this.waveState
    w.origin.copy(this.centre)
    w.origin.y = 0.06
    w.axis.set(0, 1, 0)
    w.side.set(1, 0, 0)
    w.span = this.radius * 2
    w.t = discharge
    w.fade = fired ? fade : 0
    w.seed = this.seed
    this.wave.sync(c, w, globals)
    this.wave.visible = w.fade > 0.002 && discharge < 0.999
  }
}
