import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'
import {
  parseVfxTags,
  tagsHaveVfxPrefix,
  vfxSpecSignature,
  type VfxSpec
} from './vfx/parseTags'
import { createVfxRuntime, type VfxRuntime } from './vfx/VfxHost'

const DEFAULT_BUDGET = 8
const DEFAULT_COOLDOWN_S = 0.35
const _origin = new THREE.Vector3()
const _forward = new THREE.Vector3()
const _quat = new THREE.Quaternion()

type EntityRuntime = {
  spec: VfxSpec
  sig: string
  lastCastAt: number
  loopLive: { isFinished: boolean } | null
  loggedMissingGate: boolean
}

function readTags(value: unknown): string[] {
  if (!value || typeof value !== 'object') return []
  const tags = (value as { tags?: unknown }).tags
  if (!Array.isArray(tags)) return []
  return tags.filter((t): t is string => typeof t === 'string')
}

function entityForward(node: THREE.Object3D, out: THREE.Vector3): THREE.Vector3 {
  node.getWorldQuaternion(_quat)
  out.set(0, 0, 1).applyQuaternion(_quat)
  out.y = 0
  if (out.lengthSq() < 1e-8) out.set(0, 0, 1)
  else out.normalize()
  return out
}

/**
 * Host renderer-plus: official ECS Tags + Transform → threejs-vfx pack.
 * Does not inject any guest API. Scene owns *when* (pointer / trigger); we own *look*.
 */
export class VfxBridge {
  private readonly entities = new Map<Entity, EntityRuntime>()
  private runtime: VfxRuntime | null = null
  private loading = false
  private lastUpdateSec = 0
  private lastDiagAt = 0

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined,
    private readonly getScene: () => THREE.Scene | null,
    private readonly getCamera: () => THREE.Camera | null,
    private readonly getViewport: () => { width: number; height: number }
  ) {}

  async sync(view: ProjectionView): Promise<void> {
    const { Tags, Transform, PointerEvents, TriggerArea } = this.ecs
    const nodes = this.getNodes()
    if (!nodes) return

    const seen = new Set<Entity>()
    let sawPrefix = false
    let tagged = 0

    for (const [entity] of view.getEntitiesWith(Tags)) {
      tagged += 1
      if (!Transform.has(entity)) continue
      const tags = readTags(Tags.getOrNull(entity))
      if (!tagsHaveVfxPrefix(tags)) continue
      sawPrefix = true
      const spec = parseVfxTags(tags)
      if (!spec) {
        this.dropEntity(entity)
        continue
      }
      if (!nodes.has(entity)) continue
      seen.add(entity)
      const sig = vfxSpecSignature(spec)
      let runtime = this.entities.get(entity)
      if (!runtime || runtime.sig !== sig) {
        runtime = {
          spec,
          sig,
          lastCastAt: 0,
          loopLive: null,
          loggedMissingGate: runtime?.loggedMissingGate ?? false
        }
        this.entities.set(entity, runtime)
        clientDebugLog.log(
          'scene',
          `vfx bind e${entity as number} id=${spec.id} mode=${spec.mode}` +
            (spec.range !== undefined ? ` range=${spec.range}` : '') +
            (spec.speed !== undefined ? ` speed=${spec.speed}` : ''),
          { alsoConsole: true }
        )
      } else {
        runtime.spec = spec
      }

      if (spec.mode === 'cast') {
        const gated = PointerEvents.has(entity) || TriggerArea.has(entity)
        if (!gated && !runtime.loggedMissingGate) {
          runtime.loggedMissingGate = true
          clientDebugLog.log(
            'scene',
            `vfx cast e${entity as number} id=${spec.id} waiting — add PointerEvents or TriggerArea (scene owns when)`,
            { level: 'info', alsoConsole: true }
          )
        }
      }
    }

    for (const entity of this.entities.keys()) {
      if (!seen.has(entity)) this.dropEntity(entity)
    }

    if (tagged === 0) {
      clientDebugLog.log('scene', 'vfx scan — 0 Tags on host (renderer transport may have filtered them)', {
        alsoConsole: true,
        throttleMs: 4000,
        throttleKey: 'vfx-scan-empty'
      })
    }

    if (sawPrefix) await this.ensureRuntime()
    if (!this.runtime) return
    for (const runtime of this.entities.values()) {
      void this.runtime.warm(runtime.spec.id)
    }

    if (specBudgetLogReady(this.lastDiagAt)) {
      this.lastDiagAt = performance.now()
      clientDebugLog.log(
        'scene',
        `vfx sync entities=${this.entities.size} live=${this.runtime.liveCount}`,
        { alsoConsole: false, throttleMs: 4000, throttleKey: 'vfx-sync' }
      )
    }
  }

  update(): void {
    const nowSec = performance.now() / 1000
    const dt = this.lastUpdateSec > 0 ? Math.min(0.25, Math.max(0, nowSec - this.lastUpdateSec)) : 0
    this.lastUpdateSec = nowSec
    if (!this.runtime) return

    const nodes = this.getNodes()
    if (nodes) {
      for (const [entity, runtime] of this.entities) {
        if (runtime.spec.mode !== 'loop') continue
        if (!this.runtime.isReady(runtime.spec.id)) continue
        if (runtime.loopLive && !runtime.loopLive.isFinished) continue
        runtime.loopLive = null
        const node = nodes.get(entity)
        if (!node) continue
        this.fire(entity, runtime, node, nowSec)
      }
    }

    const size = this.getViewport()
    this.runtime.update(dt, size)
  }

  notePointerUp(entity: Entity): void {
    this.tryCast(entity, 'pointer')
  }

  noteTriggerEnter(entity: Entity): void {
    this.tryCast(entity, 'trigger')
  }

  dispose(): void {
    this.entities.clear()
    this.runtime?.dispose()
    this.runtime = null
    this.loading = false
    this.lastUpdateSec = 0
  }

  private tryCast(entity: Entity, source: 'pointer' | 'trigger'): void {
    const runtime = this.entities.get(entity)
    if (!runtime || runtime.spec.mode !== 'cast') return
    const { PointerEvents, TriggerArea } = this.ecs
    if (source === 'pointer' && !PointerEvents.has(entity)) return
    if (source === 'trigger' && !TriggerArea.has(entity)) return
    const node = this.getNodes()?.get(entity)
    if (!node) return
    this.fire(entity, runtime, node, performance.now() / 1000)
  }

  private fire(entity: Entity, runtime: EntityRuntime, node: THREE.Object3D, nowSec: number): boolean {
    if (!this.runtime || !this.runtime.isReady(runtime.spec.id)) {
      void this.ensureRuntime().then(() => void this.runtime?.warm(runtime.spec.id))
      return false
    }
    const cooldown = runtime.spec.cooldown ?? DEFAULT_COOLDOWN_S
    if (nowSec - runtime.lastCastAt < cooldown) return false

    node.updateWorldMatrix(true, false)
    node.getWorldPosition(_origin)
    entityForward(node, _forward)
    const descriptor = this.runtime.lookup(runtime.spec.id)
    const defaults = descriptor?.settings ?? {}
    const fallbackRange =
      typeof defaults.range === 'number'
        ? defaults.range
        : typeof defaults.zoneRadius === 'number'
          ? defaults.zoneRadius
          : 12
    const distance = runtime.spec.range ?? fallbackRange
    const spawned = this.runtime.cast(runtime.spec, _origin, _forward, distance, DEFAULT_BUDGET)
    if (!spawned) return false
    if (runtime.spec.mode === 'loop') runtime.loopLive = spawned
    runtime.lastCastAt = nowSec
    clientDebugLog.log(
      'scene',
      `vfx ${runtime.spec.mode} e${entity as number} id=${runtime.spec.id} ` +
        `origin=(${_origin.x.toFixed(1)},${_origin.y.toFixed(1)},${_origin.z.toFixed(1)}) ` +
        `fwd=(${_forward.x.toFixed(2)},${_forward.z.toFixed(2)}) dist=${distance.toFixed(1)}`,
      { alsoConsole: true }
    )
    return true
  }

  private dropEntity(entity: Entity): void {
    this.entities.delete(entity)
  }

  private async ensureRuntime(): Promise<void> {
    if (this.runtime || this.loading) return
    const scene = this.getScene()
    const camera = this.getCamera()
    if (!scene || !camera) return
    this.loading = true
    try {
      this.runtime = await createVfxRuntime(scene, camera)
      clientDebugLog.log('scene', 'vfx pack loaded (lazy)', { alsoConsole: true })
    } catch (err) {
      clientDebugLog.log(
        'scene',
        `vfx pack load failed: ${err instanceof Error ? err.message : String(err)}`,
        { level: 'error', alsoConsole: true }
      )
    } finally {
      this.loading = false
    }
  }
}

function specBudgetLogReady(lastAt: number): boolean {
  return performance.now() - lastAt > 4000
}
