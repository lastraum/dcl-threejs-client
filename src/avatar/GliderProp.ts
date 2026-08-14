import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { clone as cloneSkinnedRoot } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { setMeshDesiredCastShadow } from '../rendering/shadowCastPolicy'

/** Explorer CharacterMotion asset — same GLB as unity-explorer GliderProp.glb. */
export const GLIDER_PROP_URL = '/avatar/glider/GliderProp.glb'
/** Converted from Explorer Glider_Start / Glider_End Unity .anim clips. */
export const GLIDER_CLIPS_URL = '/avatar/glider/gliderClips.json'

/**
 * Explorer GlideStateValue / RFC4 Movement_GlideState:
 * PROP_CLOSED → OPENING_PROP → GLIDING → CLOSING_PROP → PROP_CLOSED
 */
export type GliderPhase = 'closed' | 'opening' | 'gliding' | 'closing'

/** RFC4 Movement_GlideState wire values. */
export const GlideStateWire = {
  PROP_CLOSED: 0,
  OPENING_PROP: 1,
  GLIDING: 2,
  CLOSING_PROP: 3
} as const

export type GlideStateWireValue = (typeof GlideStateWire)[keyof typeof GlideStateWire]

/** Propeller spin while gliding (Explorer RotorRotationSpeedRange high end). */
const ROTOR_DEG_S_FULL = 360 * 4
/**
 * Local offset under avatar pivot (bind faces +Z; pivot has AVATAR_YAW_OFFSET so +Z ≈ forward).
 * Slightly down + back so handles sit at the avatar’s hands.
 */
const GLIDER_LOCAL_OFFSET = { x: 0, y: -0.18, z: -0.22 }

type ClipTrackJson = { bone: string; times: number[]; values: number[] }
type ClipJson = {
  name: string
  duration: number
  rotation: ClipTrackJson[]
  position: ClipTrackJson[]
  scale: ClipTrackJson[]
}
type ClipsFile = { start: ClipJson; end: ClipJson }

let sharedTemplate: THREE.Object3D | null = null
let sharedTemplateLoad: Promise<THREE.Object3D> | null = null
let sharedClips: { start: THREE.AnimationClip; end: THREE.AnimationClip } | null = null
let sharedClipsLoad: Promise<{ start: THREE.AnimationClip; end: THREE.AnimationClip }> | null = null

function collectNodeNames(root: THREE.Object3D): Set<string> {
  const names = new Set<string>()
  root.traverse((obj) => {
    if (obj.name) names.add(obj.name)
  })
  return names
}

/** GLTFLoader strips `. : / [ ]` from node names; clip JSON still has Unity dots. */
function resolveClipNodeName(raw: string, names: Set<string>): string | null {
  if (names.has(raw)) return raw
  const sanitized = THREE.PropertyBinding.sanitizeNodeName(raw)
  if (names.has(sanitized)) return sanitized
  return null
}

function tracksFromJson(clip: ClipJson, names: Set<string>): THREE.KeyframeTrack[] {
  const tracks: THREE.KeyframeTrack[] = []
  const push = (
    ctor: new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack,
    bone: string,
    suffix: string,
    times: number[],
    values: number[]
  ): void => {
    const node = resolveClipNodeName(bone, names)
    if (!node) return
    tracks.push(new ctor(`${node}.${suffix}`, times, values))
  }
  for (const t of clip.rotation) {
    push(THREE.QuaternionKeyframeTrack, t.bone, 'quaternion', t.times, t.values)
  }
  for (const t of clip.position) {
    push(THREE.VectorKeyframeTrack, t.bone, 'position', t.times, t.values)
  }
  for (const t of clip.scale) {
    push(THREE.VectorKeyframeTrack, t.bone, 'scale', t.times, t.values)
  }
  return tracks
}

function clipFromJson(clip: ClipJson, names: Set<string>): THREE.AnimationClip {
  return new THREE.AnimationClip(clip.name, clip.duration, tracksFromJson(clip, names))
}

async function loadGliderTemplate(): Promise<THREE.Object3D> {
  if (sharedTemplate) return sharedTemplate
  if (!sharedTemplateLoad) {
    sharedTemplateLoad = (async () => {
      const loader = new GLTFLoader()
      const gltf = await loader.loadAsync(GLIDER_PROP_URL)
      const root = gltf.scene
      root.name = 'GliderProp'
      root.traverse((obj) => {
        if ((obj as THREE.Mesh).isMesh) {
          const mesh = obj as THREE.Mesh
          setMeshDesiredCastShadow(mesh, true, 'avatar')
          mesh.receiveShadow = true
          mesh.frustumCulled = false
        }
      })
      sharedTemplate = root
      return root
    })().catch((err) => {
      sharedTemplateLoad = null
      throw err
    })
  }
  return sharedTemplateLoad
}

async function loadGliderClipFile(): Promise<ClipsFile> {
  const res = await fetch(GLIDER_CLIPS_URL)
  if (!res.ok) throw new Error(`gliderClips.json HTTP ${res.status}`)
  return (await res.json()) as ClipsFile
}

async function loadGliderClipsFor(template: THREE.Object3D): Promise<{
  start: THREE.AnimationClip
  end: THREE.AnimationClip
}> {
  if (sharedClips) return sharedClips
  if (!sharedClipsLoad) {
    sharedClipsLoad = (async () => {
      const data = await loadGliderClipFile()
      const names = collectNodeNames(template)
      const clips = {
        start: clipFromJson(data.start, names),
        end: clipFromJson(data.end, names)
      }
      sharedClips = clips
      return clips
    })().catch((err) => {
      sharedClipsLoad = null
      throw err
    })
  }
  return sharedClipsLoad
}

export function phaseToGlideStateWire(phase: GliderPhase): GlideStateWireValue {
  switch (phase) {
    case 'opening':
      return GlideStateWire.OPENING_PROP
    case 'gliding':
      return GlideStateWire.GLIDING
    case 'closing':
      return GlideStateWire.CLOSING_PROP
    default:
      return GlideStateWire.PROP_CLOSED
  }
}

/** OPENING / GLIDING want the prop open; CLOSING / CLOSED close it. */
export function glideStateWantsOpen(glideState: number): boolean {
  return (
    glideState === GlideStateWire.OPENING_PROP || glideState === GlideStateWire.GLIDING
  )
}

/**
 * Explorer glider mesh + open/close clips — parented to avatar pivot (local or remote).
 */
export class GliderProp {
  private root: THREE.Object3D | null = null
  private propellers: THREE.Object3D[] = []
  private parent: THREE.Object3D | null = null
  private mixer: THREE.AnimationMixer | null = null
  private startAction: THREE.AnimationAction | null = null
  private endAction: THREE.AnimationAction | null = null
  private phase: GliderPhase = 'closed'
  private wantOpen = false
  private bodyVisible = true
  private loadGen = 0
  private clipsReady = false

  /** Remember pivot. Mesh + clips load on first open — grounded remotes stay empty. */
  async attach(parent: THREE.Object3D): Promise<void> {
    this.detach()
    this.parent = parent
    if (this.wantOpen) await this.ensureLoaded()
  }

  private async ensureLoaded(): Promise<void> {
    const parent = this.parent
    if (!parent || this.root) return
    const gen = ++this.loadGen
    try {
      const template = await loadGliderTemplate()
      const clips = await loadGliderClipsFor(template)
      if (gen !== this.loadGen || this.parent !== parent) return

      const clone = cloneSkinnedRoot(template)
      clone.name = 'GliderProp'
      clone.visible = false
      clone.position.set(GLIDER_LOCAL_OFFSET.x, GLIDER_LOCAL_OFFSET.y, GLIDER_LOCAL_OFFSET.z)
      parent.add(clone)
      this.root = clone

      this.propellers = []
      const propL = THREE.PropertyBinding.sanitizeNodeName('DEF_glider_propeller.L')
      const propR = THREE.PropertyBinding.sanitizeNodeName('DEF_glider_propeller.R')
      clone.traverse((obj) => {
        if (
          obj.name === 'DEF_glider_propeller.L' ||
          obj.name === 'DEF_glider_propeller.R' ||
          obj.name === propL ||
          obj.name === propR
        ) {
          this.propellers.push(obj)
        }
      })

      this.mixer = new THREE.AnimationMixer(clone)
      this.startAction = this.mixer.clipAction(clips.start)
      this.startAction.setLoop(THREE.LoopOnce, 1)
      this.startAction.clampWhenFinished = true
      this.endAction = this.mixer.clipAction(clips.end)
      this.endAction.setLoop(THREE.LoopOnce, 1)
      this.endAction.clampWhenFinished = true

      this.mixer.addEventListener('finished', this.onMixerFinished)
      this.clipsReady = true

      if (this.wantOpen) this.beginOpen()
      else this.syncVisible()
    } catch (err) {
      console.warn('[glider] GliderProp load failed', err)
    }
  }

  /**
   * Desired open state from locomotion / remote glideState.
   * Drives OPENING / CLOSING; mesh stays visible through close anim.
   */
  setOpen(open: boolean): void {
    if (this.wantOpen === open) return
    this.wantOpen = open
    if (open && !this.root) {
      if (this.parent) void this.ensureLoaded()
      return
    }
    if (!this.clipsReady || !this.root) return

    if (open) {
      if (this.phase === 'closed' || this.phase === 'closing') this.beginOpen()
    } else {
      if (this.phase === 'opening' || this.phase === 'gliding') this.beginClose()
    }
  }

  /** Apply RFC4 Movement.glideState directly. */
  setGlideState(glideState: number): void {
    this.setOpen(glideStateWantsOpen(glideState))
  }

  /** Match avatar body visibility (FPV / AvatarModifierArea hide). */
  setBodyVisible(visible: boolean): void {
    this.bodyVisible = visible
    this.syncVisible()
  }

  getPhase(): GliderPhase {
    return this.phase
  }

  /** RFC4 Movement.glideState for outbound multiplayer. */
  getGlideStateWire(): GlideStateWireValue {
    return phaseToGlideStateWire(this.phase)
  }

  update(delta: number): void {
    if (!this.root || this.phase === 'closed') return
    this.mixer?.update(delta)

    // Explorer: rotors spin while gliding after open clip releases bones.
    if (this.bodyVisible && this.phase === 'gliding' && this.propellers.length) {
      const step = THREE.MathUtils.degToRad(ROTOR_DEG_S_FULL) * delta
      for (const prop of this.propellers) {
        prop.rotateZ(step)
      }
    }
  }

  detach(): void {
    this.loadGen++
    if (this.mixer) {
      this.mixer.removeEventListener('finished', this.onMixerFinished)
      this.mixer.stopAllAction()
      this.mixer.uncacheRoot(this.mixer.getRoot())
      this.mixer = null
    }
    this.startAction = null
    this.endAction = null
    this.clipsReady = false
    if (this.root) {
      this.root.removeFromParent()
      this.root = null
    }
    this.propellers = []
    this.parent = null
    this.phase = 'closed'
  }

  dispose(): void {
    this.detach()
    this.wantOpen = false
  }

  private readonly onMixerFinished = (e: { action: THREE.AnimationAction }): void => {
    const action = e.action
    if (action === this.startAction && this.phase === 'opening') {
      this.phase = 'gliding'
      this.startAction.stop()
      if (!this.wantOpen) this.beginClose()
      return
    }
    if (action === this.endAction && this.phase === 'closing') {
      this.phase = 'closed'
      this.endAction.stop()
      this.startAction?.stop()
      this.syncVisible()
      if (this.wantOpen) this.beginOpen()
    }
  }

  private beginOpen(): void {
    if (!this.mixer || !this.startAction || !this.endAction) return
    this.phase = 'opening'
    this.endAction.stop()
    this.startAction.reset()
    this.startAction.enabled = true
    this.startAction.setEffectiveWeight(1)
    this.startAction.play()
    this.syncVisible()
  }

  private beginClose(): void {
    if (!this.mixer || !this.startAction || !this.endAction) return
    this.phase = 'closing'
    this.startAction.stop()
    this.endAction.reset()
    this.endAction.enabled = true
    this.endAction.setEffectiveWeight(1)
    this.endAction.fadeIn(0.04)
    this.endAction.play()
    this.syncVisible()
  }

  private syncVisible(): void {
    if (!this.root) return
    this.root.visible = this.phase !== 'closed' && this.bodyVisible
  }
}
