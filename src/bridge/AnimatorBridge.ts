import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from '../rendering/AssetCache'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'
import { isAnimatorVerbose } from './animatorConfig'
import { deriveDefaultAnimatorStates } from './implicitAnimator'
import { isInBlimpSubtree, isMotionFocusActive, matchesMotionFocusSrc } from './motionFocus'

type AnimEntry = {
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  root: THREE.Object3D
  gltfHash: string
  gltfSrc: string
  /** Last applied ECS/default animator states — skip stop/play when unchanged. */
  lastAppliedSignature?: string
}

function hashFromSrc(src: string, scene: ResolvedScene): string | null {
  const trimmed = src.trim()
  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return trimmed
  const hit = scene.content.find((c) => c.file === trimmed || c.file.endsWith(`/${trimmed}`))
  return hit?.hash ?? null
}

type AnimatorStateView = Readonly<{
  clip?: string
  playing?: boolean
  loop?: boolean
  speed?: number
  weight?: number
  shouldReset?: boolean
}>

/** Highlight blimp / propeller assets in verbose logs (`?animatorverbose`). */
const ANIMATOR_FOCUS_SRC = /blimp|propeller|prop_/i

function isAnimatorFocusSrc(src: string): boolean {
  return ANIMATOR_FOCUS_SRC.test(src)
}

/** True if mixer needs update this frame (running, scheduled, or non-zero weight fade). */
function mixerHasActiveWork(entry: AnimEntry): boolean {
  for (const action of entry.actions.values()) {
    if (action.isRunning() || action.isScheduled()) return true
    // Paused holds still need weight applied so the pose stays on the skeleton.
    if (action.enabled && action.getEffectiveWeight() > 1e-3) return true
    if (action.enabled && action.weight > 1e-3) return true
  }
  return false
}

/**
 * Freeze a clip at a pose without resetting time to 0.
 * - Mid-play / already advanced → hold current time (SyncEntity door mid-open).
 * - Never advanced + non-loop → snap to end frame (late join sees open door, not closed).
 * - Never advanced + loop → fully off.
 */
function holdActionPose(action: THREE.AnimationAction, loop: boolean, weight: number): void {
  const duration = action.getClip().duration
  action.enabled = true
  action.setEffectiveWeight(weight)
  action.clampWhenFinished = true

  if (action.isRunning() || action.time > 1e-4) {
    action.paused = true
    return
  }

  if (!loop && duration > 1e-4) {
    // CRDT does not sync clip time — Explorer shows the finished pose when stopped.
    action.reset()
    action.time = duration
    action.paused = true
    action.play()
    action.paused = true
    return
  }

  action.stop()
  action.enabled = false
  action.paused = false
}

/** One name→node map per bind — per-track traverse was O(tracks × nodes) on huge characters. */
function buildNodeNameMap(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const byName = new Map<string, THREE.Object3D>()
  root.traverse((obj) => {
    if (obj.name && !byName.has(obj.name)) byName.set(obj.name, obj)
  })
  return byName
}

/**
 * Rebind cached GLTF clip tracks from source UUIDs → cloned instance nodes.
 * Clips stay in mesh-local space from GLTFLoader (already RH). Entity-root DCL→Three
 * conversion is only on ECS Transform via applyDclLocalTransform — do not re-reflect tracks
 * (that flipped continuous spins / skinned props).
 */
function retargetAnimationClip(
  clip: THREE.AnimationClip,
  root: THREE.Object3D,
  nodeByName?: Map<string, THREE.Object3D>
): THREE.AnimationClip {
  const nameMap = nodeByName ?? buildNodeNameMap(root)
  const tracks: THREE.KeyframeTrack[] = []
  for (const track of clip.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name)
    const nodeName = parsed.nodeName
    if (!nodeName) {
      tracks.push(track)
      continue
    }
    const target = nameMap.get(nodeName) ?? root.getObjectByName(nodeName) ?? undefined
    if (!target) {
      continue
    }
    const named = track.clone()
    const dot = track.name.indexOf('.')
    named.name = dot >= 0 ? `${target.uuid}${track.name.slice(dot)}` : track.name
    tracks.push(named)
  }
  return new THREE.AnimationClip(clip.name, clip.duration, tracks, clip.blendMode)
}

function formatAnimatorStates(states: readonly AnimatorStateView[]): string {
  if (!states.length) return '(none)'
  return states
    .map((s) => {
      const clip = s.clip ?? '?'
      const playing = s.playing !== false ? 'play' : 'stop'
      const loop = s.loop !== false ? 'loop' : 'once'
      const speed = s.speed ?? 1
      const weight = s.weight ?? 1
      const reset = s.shouldReset ? ',reset' : ''
      return `${clip}(${playing},${loop},spd=${speed},w=${weight}${reset})`
    })
    .join('; ')
}

function animatorStateSignature(
  states: readonly AnimatorStateView[],
  usingDefaultAutoPlay: boolean
): string {
  return `${usingDefaultAutoPlay ? 'default:' : ''}${formatAnimatorStates(states)}`
}

/** glTF clip playback from ECS `Animator` or DCL default auto-play on `GltfContainer`. */
export class AnimatorBridge {
  private readonly entries = new Map<Entity, AnimEntry>()
  private readonly verbose = isAnimatorVerbose()
  private readonly loggedSkips = new Set<string>()
  /** GLBs probed with no ECS Animator and zero embedded clips — skip re-probing each sync. */
  private readonly staticGltfNoClips = new Set<Entity>()
  /**
   * Animator CRDT PUTs since last sync — re-apply even when state signature is unchanged.
   * Scenes re-fire one-shots by getMutable + shouldReset=true; LWW payload may be identical
   * to the previous put so signature skip would never restart muzzle/gun clips.
   */
  private readonly dirtyReplay = new Set<Entity>()
  private motionFocusView: ProjectionView | null = null
  /** GLTF collider child meshes moved by skinning / clips this frame. */
  private readonly shapeMotionEntities = new Set<Entity>()
  private shapeMotionProbe: ((entity: Entity) => boolean) | null = null

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly cache: AssetCache,
    private readonly sceneConfig: ResolvedScene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {
    if (this.verbose) {
      const hint = isMotionFocusActive()
        ? 'Motion focus — filtered animator logs (?blimpdebug); use ?animatorverbose for all'
        : 'Animator verbose — logging bind, clips, and playback (?animatorverbose)'
      clientDebugLog.log('animator', hint, { level: 'info', alsoConsole: true })
    }
  }

  /** After mixer.update — detect per-shape collider tread motion (GltfColliderExtractor probe). */
  setShapeMotionProbe(probe: ((entity: Entity) => boolean) | null): void {
    this.shapeMotionProbe = probe
  }

  /**
   * Animator CRDT put / getMutable re-fire — must re-apply clip even if state signature matches.
   * Call from projection fold when Animator.componentId changes.
   */
  markDirty(entity: Entity): void {
    this.dirtyReplay.add(entity)
  }

  getActiveEntities(): Entity[] {
    return [...this.entries.keys()]
  }

  pendingShapeMotionEntities(): ReadonlySet<Entity> {
    return this.shapeMotionEntities
  }

  consumeShapeMotionEntities(): ReadonlySet<Entity> {
    const out = new Set(this.shapeMotionEntities)
    this.shapeMotionEntities.clear()
    return out
  }

  private logAnimator(
    message: string,
    options: { level?: 'info' | 'warn' | 'success'; throttleMs?: number; entity?: Entity } = {}
  ): void {
    if (!this.verbose) return
    if (
      isMotionFocusActive() &&
      options.entity !== undefined &&
      this.motionFocusView &&
      !isInBlimpSubtree(options.entity, this.ecs, this.motionFocusView) &&
      !matchesMotionFocusSrc(message)
    ) {
      return
    }
    const key = options.entity !== undefined ? `animator:${options.entity}` : 'animator'
    clientDebugLog.log('animator', message, {
      level: options.level ?? 'info',
      throttleKey: key,
      throttleMs: options.throttleMs,
      alsoConsole: true
    })
  }

  async sync(view: ProjectionView): Promise<void> {
    this.motionFocusView = view
    const { Animator, GltfContainer } = this.ecs
    const nodes = this.getNodes()
    if (!nodes) return
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(GltfContainer)) {
      const { src } = GltfContainer.get(entity)
      const hasExplicitAnimator = Animator.has(entity)
      if (!hasExplicitAnimator && this.staticGltfNoClips.has(entity) && !this.entries.has(entity)) {
        continue
      }

      const node = nodes.get(entity)
      if (!node) {
        const skipKey = `no-node:${entity}:${src}`
        if (!this.loggedSkips.has(skipKey)) {
          this.loggedSkips.add(skipKey)
          this.logAnimator(`Animator skip — entity ${entity} · ${src} (no scene node)`, {
            entity,
            level: 'warn'
          })
        }
        continue
      }

      const hash = hashFromSrc(src, this.sceneConfig)
      if (!hash) {
        this.logAnimator(`Animator skip — entity ${entity} · ${src} (unresolved hash)`, {
          entity,
          throttleMs: 2000,
          level: 'warn'
        })
        continue
      }

      const mesh = node.getObjectByName(`__mesh_${entity}`)
      if (!mesh) {
        this.logAnimator(`Animator wait mesh — entity ${entity} · ${src} (no __mesh_${entity} yet)`, {
          entity,
          throttleMs: 2000
        })
        continue
      }

      let entry = this.entries.get(entity)
      const rebinding = !entry || entry.gltfHash !== hash || entry.root !== mesh
      if (rebinding) {
        // P0 mesh: never await cold parse on the bridge tick. Peek cache only; kick idle load if cold.
        const template =
          this.cache.peekCached(hash) ?? this.cache.peekCached(this.sceneConfig.assetUrl(hash))
        if (!template) {
          if (!this.cache.isResolving(hash) && !this.cache.hasGivenUp(hash)) {
            void this.cache
              .load(this.sceneConfig.assetUrl(hash), hash, { quiet: true })
              .catch(() => {})
          }
          continue
        }
        entry?.mixer.stopAllAction()
        const loaded = template
        const clipNames = loaded.animations.map((c) => c.name)
        entry = {
          mixer: new THREE.AnimationMixer(mesh),
          actions: new Map(),
          root: mesh,
          gltfHash: hash,
          gltfSrc: src
        }
        // Build name map once for all clips (characters can have dozens of tracks × many bones).
        const nodeByName = loaded.animations.length ? buildNodeNameMap(mesh) : undefined
        for (const clip of loaded.animations) {
          const instanceClip = retargetAnimationClip(clip, mesh, nodeByName)
          entry.actions.set(clip.name, entry.mixer.clipAction(instanceClip, mesh))
        }
        if (!hasExplicitAnimator && !clipNames.length) {
          this.staticGltfNoClips.add(entity)
          continue
        }
        this.staticGltfNoClips.delete(entity)
        entry.lastAppliedSignature = undefined
        this.entries.set(entity, entry)
        const focus = isAnimatorFocusSrc(src)
        this.logAnimator(
          `Animator bind — entity ${entity} · ${src} · clips [${clipNames.join(', ') || '(none)'}] · mesh children ${mesh.children.length}`,
          { entity, level: clipNames.length ? 'success' : 'warn', throttleMs: focus ? 0 : undefined }
        )
        if (focus) {
          const childNames: string[] = []
          mesh.traverse((obj) => {
            if (obj !== mesh && obj.name) childNames.push(obj.name)
          })
          this.logAnimator(
            `Animator focus — entity ${entity} · nodes [${childNames.slice(0, 24).join(', ')}${childNames.length > 24 ? ',…' : ''}]`,
            { entity, throttleMs: 0 }
          )
        }
        if (!clipNames.length) {
          this.logAnimator(`Animator no clips in GLB — entity ${entity} · ${src}`, {
            entity,
            level: 'warn'
          })
        }
      }

      const bound = this.entries.get(entity)
      if (!bound) continue

      const clipNames = [...bound.actions.keys()]
      let states: readonly AnimatorStateView[]
      let usingDefaultAutoPlay = false
      if (Animator.has(entity)) {
        states = (Animator.get(entity).states ?? []) as readonly AnimatorStateView[]
      } else {
        states = deriveDefaultAnimatorStates(clipNames)
        usingDefaultAutoPlay = states.length > 0
        if (usingDefaultAutoPlay) {
          this.logAnimator(
            `Animator default — entity ${entity} · ${src} · auto-play first clip [${states[0]?.clip ?? '?'}] (DCL spec, no ECS Animator)`,
            { entity, level: 'info', throttleMs: isAnimatorFocusSrc(src) ? 0 : 5000 }
          )
        }
      }
      if (!states.length) continue
      active.add(entity)

      const stateSignature = animatorStateSignature(states, usingDefaultAutoPlay)
      const forceReplay = this.dirtyReplay.has(entity)
      this.dirtyReplay.delete(entity)
      // Signature skip is correct for idle holds — but identical shouldReset re-fires
      // (muzzle flash / gun shot) arrive as CRDT dirties with the same state payload.
      if (!rebinding && !forceReplay && bound.lastAppliedSignature === stateSignature) {
        continue
      }

      // Do not action.stop() everything first — that resets clip time to 0 and forces full
      // open→close on the next play (SyncEntity doors / gates). Explorer keeps the current
      // pose when playing=false and only restarts on shouldReset.
      const activeClipNames = new Set(
        states.map((s) => s.clip ?? '').filter((n) => n.length > 0)
      )
      for (const [name, action] of bound.actions) {
        if (!activeClipNames.has(name)) {
          action.stop()
          action.enabled = false
          action.paused = false
        }
      }

      const playingClips: string[] = []
      const heldClips: string[] = []
      const missingClips: string[] = []

      for (const state of states) {
        const clipName = state.clip ?? ''
        const action = bound.actions.get(clipName)
        if (!action) {
          if (clipName) missingClips.push(clipName)
          continue
        }
        const loop = state.loop !== false
        const weight = state.weight ?? 1
        action.setEffectiveTimeScale(state.speed ?? 1)
        action.setLoop(loop ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        action.clampWhenFinished = !loop
        if (state.playing !== false) {
          action.enabled = true
          action.paused = false
          action.setEffectiveWeight(weight)
          // Explorer: shouldReset restarts one-shots; forceReplay also restarts when scene
          // re-dirties Animator with the same shouldReset=true payload.
          if (state.shouldReset || forceReplay) action.reset()
          if (!action.isRunning()) action.play()
          playingClips.push(clipName)
        } else if (weight > 1e-3) {
          holdActionPose(action, loop, weight)
          if (action.enabled) heldClips.push(clipName)
        } else {
          action.stop()
          action.enabled = false
          action.paused = false
          action.setEffectiveWeight(0)
        }
      }

      // Bake held/end poses immediately (don't wait for next mixer tick).
      if (heldClips.length && !playingClips.length) {
        bound.mixer.update(0)
      }

      if (missingClips.length) {
        this.logAnimator(
          `Animator clip missing — entity ${entity} · ${src} · requested [${missingClips.join(', ')}] · available [${[...bound.actions.keys()].join(', ')}]`,
          { entity, level: 'warn', throttleMs: 1500 }
        )
      }

      if (bound.lastAppliedSignature !== stateSignature) {
        this.logAnimator(
          `Animator states — entity ${entity} · ${src} · ${formatAnimatorStates(states)} · active clips [${playingClips.join(', ') || '(none)'}]${heldClips.length ? ` · held [${heldClips.join(', ')}]` : ''}${usingDefaultAutoPlay ? ' · default auto-play' : ''}`,
          { entity }
        )
      }
      bound.lastAppliedSignature = stateSignature
    }

    for (const [entity, entry] of this.entries) {
      if (!active.has(entity)) {
        entry.mixer.stopAllAction()
        this.entries.delete(entity)
        this.logAnimator(`Animator removed — entity ${entity}`, { entity })
      }
    }

    for (const entity of this.staticGltfNoClips) {
      if (!GltfContainer.has(entity)) this.staticGltfNoClips.delete(entity)
    }
  }

  update(delta: number): void {
    if (!this.entries.size) return

    for (const [entity, entry] of this.entries) {
      // Phase C: skip mixer.tick when nothing is running / fading (idle GLTF animators).
      if (!mixerHasActiveWork(entry)) continue
      entry.mixer.update(delta)
      if (this.shapeMotionProbe?.(entity)) {
        this.shapeMotionEntities.add(entity)
      }
    }

    if (!this.verbose) return

    const playing: string[] = []
    for (const [entity, entry] of this.entries) {
      const active = [...entry.actions.entries()]
        .filter(([, action]) => action.isRunning() && action.enabled)
        .map(([name]) => name)
      if (active.length) playing.push(`${entity}:[${active.join(',')}]`)
    }

    const maxListed = 6
    const listed = playing.slice(0, maxListed)
    const overflow = playing.length > maxListed ? ` · +${playing.length - maxListed} more` : ''
    const focusRunning = playing.filter((line) => {
      const entityId = Number(line.split(':')[0])
      const entry = this.entries.get(entityId as Entity)
      return entry != null && isAnimatorFocusSrc(entry.gltfSrc)
    })
    this.logAnimator(
      `Animator tick — ${this.entries.size} mixer(s) · ${playing.length} running · ${listed.join(' · ') || '(none)'}${overflow}${focusRunning.length ? ` · focus ${focusRunning.join(' · ')}` : ''}`,
      { throttleMs: 3000 }
    )
  }
}