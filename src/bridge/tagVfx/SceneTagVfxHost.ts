import * as THREE from 'three'
import type { Entity } from '@dcl/ecs'
import { dclToThreePos } from '../dclTransform'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'
import type { MirrorComponents } from '../mirrorComponents'
import type { ProjectionView } from '../ProjectionView'
import { IceLineCast } from './iceLineCast'
import { getSceneAbilityVfxHost } from '../../vfx/SceneAbilityVfxHost'

const KIND_PREFIX = 'tjs.vfx:'
const MODE_PREFIX = 'tjs.vfx.mode:'
const RANGE_PREFIX = 'tjs.vfx.range:'
const SPEED_PREFIX = 'tjs.vfx.speed:'
const DIR_PREFIX = 'tjs.vfx.dir:'
const YAW_PREFIX = 'tjs.vfx.yaw:'
const ORIGIN_PREFIX = 'tjs.vfx.origin:'

type VfxKind = 'ice'
type VfxMode = 'loop' | 'cast'

type TagSpec = {
  entity: Entity
  kind: VfxKind
  mode: VfxMode
  range: number
  speed: number
  /** DCL world dir if authored (`tjs.vfx.dir:x,y,z`). */
  dirDcl: THREE.Vector3 | null
  /** Degrees, 0 = DCL +Z north. */
  yawDeg: number | null
  /** DCL world start if authored (`tjs.vfx.origin:x,y,z`). */
  originDcl: THREE.Vector3 | null
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

function parseDir(raw: string): THREE.Vector3 | null {
  const parts = raw.split(',').map((s) => Number(s.trim()))
  if (parts.length < 3) return null
  const x = parts[0]
  const y = parts[1]
  const z = parts[2]
  if (![x, y, z].every((n) => typeof n === 'number' && Number.isFinite(n))) return null
  const v = new THREE.Vector3(x, y, z)
  if (v.lengthSq() < 1e-8) return null
  return v
}

function parseSpec(entity: Entity, tags: readonly string[]): TagSpec | null {
  let kind: VfxKind | null = null
  let mode: VfxMode = 'loop'
  let range = 32
  let speed = 24
  let dirDcl: THREE.Vector3 | null = null
  let yawDeg: number | null = null
  let originDcl: THREE.Vector3 | null = null
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
    } else if (tag.startsWith(DIR_PREFIX)) {
      dirDcl = parseDir(tag.slice(DIR_PREFIX.length))
    } else if (tag.startsWith(YAW_PREFIX)) {
      const n = Number(tag.slice(YAW_PREFIX.length))
      if (Number.isFinite(n)) yawDeg = n
    } else if (tag.startsWith(ORIGIN_PREFIX)) {
      originDcl = parseDir(tag.slice(ORIGIN_PREFIX.length))
    }
  }
  if (!kind) return null
  return { entity, kind, mode, range, speed, dirDcl, yawDeg, originDcl }
}

function specFromName(entity: Entity, name: string): TagSpec | null {
  const raw = name.trim()
  if (!raw.startsWith('tjs.vfx:')) return null
  const parts = raw.split('|').map((s) => s.trim())
  const kind = parseKind(parts[0] ?? '')
  if (!kind) return null
  const mode: VfxMode = parts[1] === 'cast' ? 'cast' : 'loop'
  const range = Number(parts[2])
  return {
    entity,
    kind,
    mode,
    range: Number.isFinite(range) && range > 0 ? range : 32,
    speed: 24,
    dirDcl: mode === 'cast' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
    yawDeg: null,
    originDcl: null
  }
}

function defaultCastSpec(entity: Entity): TagSpec {
  return {
    entity,
    kind: 'ice',
    mode: 'cast',
    range: 32,
    speed: 24,
    dirDcl: new THREE.Vector3(1, 0, 0),
    yawDeg: null,
    originDcl: null
  }
}

function resolveDir(spec: TagSpec, node: THREE.Group): THREE.Vector3 {
  if (spec.dirDcl) {
    dclToThreePos(spec.dirDcl.x, spec.dirDcl.y, spec.dirDcl.z, _dir)
    _dir.y = 0
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1)
    return _dir.normalize()
  }
  if (spec.yawDeg != null) {
    const rad = (spec.yawDeg * Math.PI) / 180
    // DCL yaw 0 = +Z north; X is reflected in Three.
    dclToThreePos(Math.sin(rad), 0, Math.cos(rad), _dir)
    _dir.y = 0
    return _dir.normalize()
  }
  node.getWorldQuaternion(_quat)
  _dir.set(0, 0, 1).applyQuaternion(_quat)
  _dir.y = 0
  if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1)
  return _dir.normalize()
}

/**
 * Client-only VFX from scene `Tags` (`tjs.vfx:ice`, `tjs.vfx.mode:loop|cast`).
 * Official ECS ParticleSystem is a different API — this scene never writes it.
 */
export class SceneTagVfxHost {
  private readonly casters = new Map<Entity, Caster>()
  private logged = 0
  private loggedEmpty = false

  constructor(
    private readonly ecs: MirrorComponents,
    _worldScene: THREE.Scene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {}

  sync(view: ProjectionView): void {
    const { Tags, Name, PointerEvents } = this.ecs
    const seen = new Set<Entity>()

    for (const [entity] of view.getEntitiesWith(Tags)) {
      const value = Tags.getOrNull(entity) as { tags?: string[] } | null
      const spec = parseSpec(entity, value?.tags ?? [])
      if (!spec) continue
      this.upsert(entity, spec, seen)
    }

    if (Name) {
      for (const [entity] of view.getEntitiesWith(Name)) {
        if (seen.has(entity)) continue
        const value = Name.getOrNull(entity) as { value?: string } | null
        const spec = specFromName(entity, value?.value ?? '')
        if (!spec) continue
        this.upsert(entity, spec, seen)
      }
    }

    if (PointerEvents) {
      for (const [entity] of view.getEntitiesWith(PointerEvents)) {
        if (seen.has(entity)) continue
        const pe = PointerEvents.getOrNull(entity) as {
          pointerEvents?: Array<{ eventInfo?: { hoverText?: string } }>
        } | null
        const hover = pe?.pointerEvents?.some((e) =>
          (e.eventInfo?.hoverText ?? '').toLowerCase().includes('ice')
        )
        if (!hover) continue
        this.upsert(entity, defaultCastSpec(entity), seen)
      }
    }

    if (this.casters.size === 0 && !this.loggedEmpty) {
      this.loggedEmpty = true
      clientDebugLog.log('scene', 'tag-vfx sync — 0 casters (Tags/Name/PE ice not on projection)', {
        alsoConsole: true,
        level: 'warn'
      })
    }
  }

  notifyPointerDown(entity: Entity): void {
    let caster = this.casters.get(entity)
    if (!caster) {
      const tags = this.ecs.Tags.getOrNull(entity) as { tags?: string[] } | null
      const named = this.ecs.Name?.getOrNull(entity) as { value?: string } | null
      const spec =
        parseSpec(entity, tags?.tags ?? []) ??
        specFromName(entity, named?.value ?? '') ??
        defaultCastSpec(entity)
      caster = this.upsert(entity, spec, new Set())
      clientDebugLog.log(
        'scene',
        `tag-vfx click-bind e${entity as number} mode=${spec.mode} range=${spec.range}`,
        { alsoConsole: true }
      )
    }
    this.fire(caster, 'pointer')
  }

  update(dt: number): void {
    const step = Math.min(0.05, Math.max(0, dt))
    const ability = getSceneAbilityVfxHost()
    for (const caster of this.casters.values()) {
      if (caster.live) {
        caster.live.update(step)
        if (caster.live.finished) {
          caster.live.dispose()
          caster.live = null
        }
      }
      if (caster.spec.mode !== 'loop') continue
      if (ability?.isBusy(caster.spec.kind) || ability?.isCasting(caster.spec.kind)) continue
      this.fire(caster, 'loop')
    }
  }

  dispose(): void {
    for (const caster of this.casters.values()) caster.live?.dispose()
    this.casters.clear()
  }

  private upsert(entity: Entity, spec: TagSpec, seen: Set<Entity>): Caster {
    seen.add(entity)
    const prev = this.casters.get(entity)
    if (prev) {
      prev.spec = spec
      return prev
    }
    const caster: Caster = { spec, live: null }
    this.casters.set(entity, caster)
    this.logged++
    if (this.logged <= 8) {
      const aim = spec.dirDcl
        ? `dir=${spec.dirDcl.x},${spec.dirDcl.y},${spec.dirDcl.z}`
        : spec.yawDeg != null
          ? `yaw=${spec.yawDeg}`
          : 'dir=entity+Z'
      const start = spec.originDcl
        ? ` origin=${spec.originDcl.x},${spec.originDcl.y},${spec.originDcl.z}`
        : ' origin=entity'
      clientDebugLog.log(
        'scene',
        `tag-vfx bind e${entity as number} ${spec.kind} mode=${spec.mode} ${aim}${start} range=${spec.range}`,
        { alsoConsole: true }
      )
    }
    return caster
  }

  private resolveOrigin(spec: TagSpec, node: THREE.Group): THREE.Vector3 {
    if (spec.originDcl) {
      dclToThreePos(spec.originDcl.x, spec.originDcl.y, spec.originDcl.z, _origin)
      return _origin
    }
    node.getWorldPosition(_origin)
    _origin.y = 0
    return _origin
  }

  private fire(caster: Caster, reason: 'loop' | 'pointer'): void {
    const nodes = this.getNodes()
    const node = nodes?.get(caster.spec.entity)
    if (!node) return
    node.updateWorldMatrix(true, false)
    const origin = this.resolveOrigin(caster.spec, node)
    const dir = resolveDir(caster.spec, node)
    caster.live?.dispose()
    caster.live = null

    const ability = getSceneAbilityVfxHost()
    if (ability) {
      const ok = ability.cast(caster.spec.kind, origin, dir, caster.spec.range)
      clientDebugLog.log(
        'scene',
        `tag-vfx ${ok ? 'ice' : 'queued'} e${caster.spec.entity as number} ${reason} ` +
          `start=(${origin.x.toFixed(1)},${origin.y.toFixed(1)},${origin.z.toFixed(1)}) ` +
          `dir=(${dir.x.toFixed(2)},${dir.z.toFixed(2)}) range=${caster.spec.range}`,
        { alsoConsole: true }
      )
      return
    }

    clientDebugLog.log(
      'scene',
      'tag-vfx no AbilityManager host — real ice cannot fire (World not ready)',
      { level: 'warn', alsoConsole: true }
    )
  }
}
