import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import type { MirrorComponents } from '../mirrorComponents'
import type { ProjectionView } from '../ProjectionView'
import { IceLineCast } from './iceLineCast'

const KIND_PREFIX = 'tjs.vfx:'
const MODE_PREFIX = 'tjs.vfx.mode:'
const RANGE_PREFIX = 'tjs.vfx.range:'
const SPEED_PREFIX = 'tjs.vfx.speed:'

type VfxKind = 'ice'
type VfxMode = 'loop' | 'cast'

type TagSpec = {
  entity: Entity
  kind: VfxKind
  mode: VfxMode
  range: number
  speed: number
}

type Caster = {
  spec: TagSpec
  live: IceLineCast | null
}

const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _quat = new THREE.Quaternion()

function parseKind(tag: string): VfxKind | null {
  if (!tag.startsWith(KIND_PREFIX)) return null
  const rest = tag.slice(KIND_PREFIX.length).trim().toLowerCase()
  if (rest.includes(':')) return null
  return rest === 'ice' ? 'ice' : null
}

function parseSpec(entity: Entity, tags: readonly string[]): TagSpec | null {
  let kind: VfxKind | null = null
  let mode: VfxMode = 'loop'
  let range = 18
  let speed = 24
  for (const raw of tags) {
    const tag = raw.trim()
    const parsed = parseKind(tag)
    if (parsed) kind = parsed
    else if (tag.startsWith(MODE_PREFIX)) {
      const m = tag.slice(MODE_PREFIX.length).trim().toLowerCase()
      if (m === 'cast' || m === 'loop') mode = m
    } else if (tag.startsWith(RANGE_PREFIX)) {
      const n = Number(tag.slice(RANGE_PREFIX.length))
      if (Number.isFinite(n) && n > 0) range = n
    } else if (tag.startsWith(SPEED_PREFIX)) {
      const n = Number(tag.slice(SPEED_PREFIX.length))
      if (Number.isFinite(n) && n > 0) speed = n
    }
  }
  if (!kind) return null
  return { entity, kind, mode, range, speed }
}

/**
 * Client-only VFX from scene `Tags` (`tjs.vfx:ice`, `tjs.vfx.mode:loop|cast`).
 * Official ECS ParticleSystem is a different API — this scene never writes it.
 */
export class SceneTagVfxHost {
  private readonly casters = new Map<Entity, Caster>()
  private logged = 0

  constructor(
    private readonly ecs: MirrorComponents,
    private readonly worldScene: THREE.Scene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {}

  sync(view: ProjectionView): void {
    const { Tags } = this.ecs
    const seen = new Set<Entity>()
    for (const [entity] of view.getEntitiesWith(Tags)) {
      const value = Tags.get(entity) as { tags?: string[] } | null
      const spec = parseSpec(entity, value?.tags ?? [])
      if (!spec) continue
      seen.add(entity)
      const prev = this.casters.get(entity)
      if (!prev) {
        this.casters.set(entity, { spec, live: null })
        this.logged++
        if (this.logged <= 8) {
          clientDebugLog.log(
            'scene',
            `tag-vfx bind e${entity as number} ${spec.kind} mode=${spec.mode} range=${spec.range} speed=${spec.speed}`,
            { alsoConsole: true }
          )
        }
      } else {
        prev.spec = spec
      }
    }
    for (const [entity, caster] of this.casters) {
      if (seen.has(entity)) continue
      caster.live?.dispose()
      this.casters.delete(entity)
    }
  }

  notifyPointerDown(entity: Entity): void {
    const caster = this.casters.get(entity)
    if (!caster || caster.spec.mode !== 'cast') return
    this.fire(caster, 'pointer')
  }

  update(dt: number): void {
    const step = Math.min(0.05, Math.max(0, dt))
    for (const caster of this.casters.values()) {
      if (caster.live) {
        caster.live.update(step)
        if (caster.live.finished) {
          caster.live.dispose()
          caster.live = null
        }
      }
      if (!caster.live && caster.spec.mode === 'loop') {
        this.fire(caster, 'loop')
      }
    }
  }

  dispose(): void {
    for (const caster of this.casters.values()) caster.live?.dispose()
    this.casters.clear()
  }

  private fire(caster: Caster, reason: 'loop' | 'pointer'): void {
    if (caster.live) {
      caster.live.dispose()
      caster.live = null
    }
    const nodes = this.getNodes()
    const node = nodes?.get(caster.spec.entity)
    if (!node) return
    node.updateWorldMatrix(true, false)
    node.getWorldPosition(_origin)
    node.getWorldQuaternion(_quat)
    _dir.set(0, 0, 1).applyQuaternion(_quat)
    const cast = new IceLineCast(_origin.clone(), _dir.clone(), caster.spec.range, caster.spec.speed)
    this.worldScene.add(cast.group)
    caster.live = cast
    clientDebugLog.log(
      'scene',
      `tag-vfx fire e${caster.spec.entity as number} ${caster.spec.kind} ${reason} ` +
        `from=(${_origin.x.toFixed(1)},${_origin.y.toFixed(1)},${_origin.z.toFixed(1)}) +Z`,
      { alsoConsole: true }
    )
  }
}
