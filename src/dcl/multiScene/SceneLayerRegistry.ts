/**
 * Phase A — every running scene is a layer (primary, PE, secondary).
 * Behavior-preserving: registry only tracks systems; claim merge is Phase B.
 */
import type { SceneScriptSystem } from '../../core/systems/SceneScriptSystem'
import { SCENE_WORKER_PRIORITY, type SceneWorkerKind } from './types'

export type SceneLayer = {
  id: string
  kind: SceneWorkerKind
  system: SceneScriptSystem
  priority: number
  /** PhysX entity id offset (PE / secondary namespaces). Primary = 0. */
  physOffset: number
}

export const PRIMARY_LAYER_ID = 'primary'

/**
 * Authoritative list of running SceneScriptSystems for multi-scene host loops.
 * World registers primary; PE/secondary managers register their slots.
 */
export class SceneLayerRegistry {
  private readonly layers = new Map<string, SceneLayer>()
  private lastLogKey = ''

  register(layer: Omit<SceneLayer, 'priority'> & { priority?: number }): void {
    const priority = layer.priority ?? SCENE_WORKER_PRIORITY[layer.kind]
    this.layers.set(layer.id, {
      id: layer.id,
      kind: layer.kind,
      system: layer.system,
      priority,
      physOffset: layer.physOffset ?? 0
    })
    this.logIfChanged()
  }

  unregister(id: string): void {
    if (!this.layers.delete(id)) return
    this.logIfChanged()
  }

  get(id: string): SceneLayer | undefined {
    return this.layers.get(id)
  }

  has(id: string): boolean {
    return this.layers.has(id)
  }

  /** All layers, highest priority first (primary → pe → secondary). */
  list(): SceneLayer[] {
    return [...this.layers.values()].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  }

  /** Running systems only (same order as list). */
  systems(): SceneScriptSystem[] {
    return this.list().map((l) => l.system)
  }

  layersOfKind(kind: SceneWorkerKind): SceneLayer[] {
    return this.list().filter((l) => l.kind === kind)
  }

  size(): number {
    return this.layers.size
  }

  clear(): void {
    this.layers.clear()
    this.lastLogKey = ''
  }

  private logIfChanged(): void {
    const key = this.list()
      .map((l) => `${l.kind}:${l.id.slice(0, 24)}`)
      .join(',')
    if (key === this.lastLogKey) return
    this.lastLogKey = key
    const kinds = this.list().map((l) => l.kind)
    console.info(`[layers] registry n=${this.layers.size} kinds=${kinds.join(',') || '∅'}`)
  }
}
