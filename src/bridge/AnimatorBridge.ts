import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import type { ResolvedScene } from '../dcl/content/types'
import type { AssetCache } from '../rendering/AssetCache'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'

type AnimEntry = {
  mixer: THREE.AnimationMixer
  actions: Map<string, THREE.AnimationAction>
  root: THREE.Object3D
  gltfHash: string
}

function hashFromSrc(src: string, scene: ResolvedScene): string | null {
  const trimmed = src.trim()
  if (/^(bafy|bafkre|Qm)/i.test(trimmed)) return trimmed
  const hit = scene.content.find((c) => c.file === trimmed || c.file.endsWith(`/${trimmed}`))
  return hit?.hash ?? null
}

/** glTF clip playback from ECS `Animator` on entities with `GltfContainer`. */
export class AnimatorBridge {
  private readonly entries = new Map<Entity, AnimEntry>()

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly cache: AssetCache,
    private readonly sceneConfig: ResolvedScene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {}

  async sync(view: ProjectionView): Promise<void> {
    const { Animator, GltfContainer } = this.ecs
    const nodes = this.getNodes()
    if (!nodes) return
    const active = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(Animator)) {
      if (!GltfContainer.has(entity)) continue
      const node = nodes.get(entity)
      if (!node) continue
      active.add(entity)

      const { src } = GltfContainer.get(entity)
      const hash = hashFromSrc(src, this.sceneConfig)
      if (!hash) continue

      const mesh = node.getObjectByName(`__mesh_${entity}`)
      if (!mesh) continue

      let entry = this.entries.get(entity)
      if (!entry || entry.gltfHash !== hash || entry.root !== mesh) {
        entry?.mixer.stopAllAction()
        const loaded = await this.cache.load(this.sceneConfig.assetUrl(hash), hash)
        entry = {
          mixer: new THREE.AnimationMixer(mesh),
          actions: new Map(),
          root: mesh,
          gltfHash: hash
        }
        for (const clip of loaded.animations) {
          entry.actions.set(clip.name, entry.mixer.clipAction(clip))
        }
        this.entries.set(entity, entry)
      }

      const states = Animator.get(entity).states ?? []
      for (const action of entry.actions.values()) {
        action.stop()
        action.enabled = false
      }

      for (const state of states) {
        const action = entry.actions.get(state.clip)
        if (!action) continue
        action.enabled = true
        action.setEffectiveWeight(state.weight ?? 1)
        action.setEffectiveTimeScale(state.speed ?? 1)
        action.setLoop(state.loop !== false ? THREE.LoopRepeat : THREE.LoopOnce, Infinity)
        if (state.playing !== false) {
          if (state.shouldReset) action.reset()
          action.play()
        }
      }
    }

    for (const [entity, entry] of this.entries) {
      if (!active.has(entity)) {
        entry.mixer.stopAllAction()
        this.entries.delete(entity)
      }
    }
  }

  update(delta: number): void {
    for (const entry of this.entries.values()) {
      entry.mixer.update(delta)
    }
  }
}
