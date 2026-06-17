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

/** Rebind cached GLTF clip tracks from source UUIDs → cloned instance nodes. */
function retargetAnimationClip(clip: THREE.AnimationClip, root: THREE.Object3D): THREE.AnimationClip {
  const tracks: THREE.KeyframeTrack[] = []
  for (const track of clip.tracks) {
    const parsed = THREE.PropertyBinding.parseTrackName(track.name)
    const nodeName = parsed.nodeName
    if (!nodeName) {
      tracks.push(track)
      continue
    }
    let target: THREE.Object3D | undefined = root.getObjectByName(nodeName)
    if (!target) {
      root.traverse((obj) => {
        if (!target && obj.name === nodeName) target = obj
      })
    }
    if (!target) {
      tracks.push(track)
      continue
    }
    const rebound = track.clone()
    const dot = track.name.indexOf('.')
    rebound.name = dot >= 0 ? `${target.uuid}${track.name.slice(dot)}` : track.name
    tracks.push(rebound)
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
  private motionFocusView: ProjectionView | null = null

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
        entry?.mixer.stopAllAction()
        const loaded = await this.cache.load(this.sceneConfig.assetUrl(hash), hash)
        const clipNames = loaded.animations.map((c) => c.name)
        entry = {
          mixer: new THREE.AnimationMixer(mesh),
          actions: new Map(),
          root: mesh,
          gltfHash: hash,
          gltfSrc: src
        }
        for (const clip of loaded.animations) {
          const instanceClip = retargetAnimationClip(clip, mesh)
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
      if (!rebinding && bound.lastAppliedSignature === stateSignature) {
        continue
      }

      for (const action of bound.actions.values()) {
        action.stop()
        action.enabled = false
      }

      const playingClips: string[] = []
      const missingClips: string[] = []

      for (const state of states) {
        const clipName = state.clip ?? ''
        const action = bound.actions.get(clipName)
        if (!action) {
          if (clipName) missingClips.push(clipName)
          continue
        }
        action.enabled = true
        action.setEffectiveWeight(state.weight ?? 1)
        action.setEffectiveTimeScale(state.speed ?? 1)
        action.setLoop(state.loop !== false ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        if (state.playing !== false) {
          if (state.shouldReset) action.reset()
          action.play()
          playingClips.push(clipName)
        }
      }

      if (missingClips.length) {
        this.logAnimator(
          `Animator clip missing — entity ${entity} · ${src} · requested [${missingClips.join(', ')}] · available [${[...bound.actions.keys()].join(', ')}]`,
          { entity, level: 'warn', throttleMs: 1500 }
        )
      }

      const logSignature = `${stateSignature}|playing:${playingClips.join(',')}`
      if (bound.lastAppliedSignature !== logSignature) {
        this.logAnimator(
          `Animator states — entity ${entity} · ${src} · ${formatAnimatorStates(states)} · active clips [${playingClips.join(', ') || '(none)'}]${usingDefaultAutoPlay ? ' · default auto-play' : ''}`,
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

    for (const entry of this.entries.values()) {
      entry.mixer.update(delta)
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