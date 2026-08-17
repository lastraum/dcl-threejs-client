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
const TARGET_PREFIX = 'tjs.vfx.target:'

type VfxKind = 'ice' | 'hail' | 'meteor'
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
  /** DCL world impact if authored (`tjs.vfx.target:x,y,z`). */
  targetDcl: THREE.Vector3 | null
}

type Caster = {
  spec: TagSpec
  live: IceLineCast | null
}

const _origin = new THREE.Vector3()
const _dir = new THREE.Vector3()
const _target = new THREE.Vector3()
const _quat = new THREE.Quaternion()

function parseKind(tag: string): VfxKind | null {
  if (!tag.startsWith(KIND_PREFIX)) return null
  const rest = tag.slice(KIND_PREFIX.length).trim().toLowerCase()
  if (rest.includes(':')) return null
  if (rest === 'ice' || rest === 'hail' || rest === 'meteor') return rest
  if (rest === 'hailwraith') return 'hail'
  if (rest === 'cinder' || rest === 'cinderfall' || rest === 'cinder-fall') return 'meteor'
  return null
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
  let targetDcl: THREE.Vector3 | null = null
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
    } else if (tag.startsWith(TARGET_PREFIX)) {
      targetDcl = parseDir(tag.slice(TARGET_PREFIX.length))
    }
  }
  if (!kind) return null
  return { entity, kind, mode, range, speed, dirDcl, yawDeg, originDcl, targetDcl }
}

function specFromName(entity: Entity, name: string): TagSpec | null {
  const raw = name.trim()
  if (!raw.startsWith('tjs.vfx:')) return null
  const parts = raw.split('|').map((s) => s.trim())
  const kind = parseKind(parts[0] ?? '')
  if (!kind) return null
  const mode: VfxMode = parts[1] === 'cast' ? 'cast' : 'loop'
  const range = Number(parts[2])
  const targetDcl = parts[3] ? parseDir(parts[3]) : null
  return {
    entity,
    kind,
    mode,
    range: Number.isFinite(range) && range > 0 ? range : 32,
    speed: 24,
    dirDcl: mode === 'cast' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
    yawDeg: null,
    originDcl: null,
    targetDcl
  }
}

function kindFromHover(hover: string): VfxKind | null {
  if (hover.includes('hail')) return 'hail'
  if (hover.includes('cinder') || hover.includes('meteor')) return 'meteor'
  if (hover.includes('ice') || hover.includes('frost')) return 'ice'
  return null
}

function defaultCastSpec(entity: Entity, kind: VfxKind): TagSpec {
  return {
    entity,
    kind,
    mode: 'cast',
    range: 32,
    speed: 24,
    dirDcl: kind === 'ice' ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 0, 1),
    yawDeg: null,
    originDcl: null,
    targetDcl: null
  }
}

function resolveDir(spec: TagSpec, node: THREE.Group | undefined): THREE.Vector3 {
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
  if (node) {
    node.getWorldQuaternion(_quat)
    _dir.set(0, 0, 1).applyQuaternion(_quat)
    _dir.y = 0
    if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1)
    return _dir.normalize()
  }
  return _dir.set(0, 0, 1)
}

/**
 * Client-only VFX from scene `Tags` (`tjs.vfx:ice`, `tjs.vfx.mode:loop|cast`).
 * Official ECS ParticleSystem is a different API — this scene never writes it.
 */
export class SceneTagVfxHost {
  private readonly casters = new Map<Entity, Caster>()
  /** Cast-mode entities fire once when first seen, then never again. */
  private readonly pendingCast = new Set<Entity>()
  private readonly firedOnce = new Set<Entity>()
  private logged = 0
  private loggedEmpty = false
  /** Three-space floor point of `anime-car` GLB if the scene spawned one. */
  private carTarget: THREE.Vector3 | null = null

  constructor(
    private readonly ecs: MirrorComponents,
    _worldScene: THREE.Scene,
    private readonly getNodes: () => Map<Entity, THREE.Group> | undefined
  ) {}

  sync(view: ProjectionView): void {
    const { Tags, Name, GltfContainer, Transform } = this.ecs
    this.refreshCarTarget(view, GltfContainer, Transform)
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

    // Click cubes are buttons only (no Tags). Do not bind hover-text as a caster —
    // each click already spawned a fresh tagged shot entity.

    for (const [entity, caster] of this.casters) {
      if (seen.has(entity)) continue
      caster.live?.dispose()
      this.casters.delete(entity)
      this.pendingCast.delete(entity)
      this.firedOnce.delete(entity)
    }

    if (this.casters.size === 0 && !this.loggedEmpty) {
      this.loggedEmpty = true
      clientDebugLog.log('scene', 'tag-vfx sync — 0 casters (Tags/Name ice not on projection)', {
        alsoConsole: true,
        level: 'warn'
      })
    }
  }

  notifyPointerDown(entity: Entity): void {
    const tags = this.ecs.Tags.getOrNull(entity) as { tags?: string[] } | null
    const named = this.ecs.Name?.getOrNull(entity) as { value?: string } | null
    const pe = this.ecs.PointerEvents?.getOrNull(entity) as {
      pointerEvents?: Array<{ eventInfo?: { hoverText?: string } }>
    } | null
    const hover = (pe?.pointerEvents ?? [])
      .map((e) => (e.eventInfo?.hoverText ?? '').toLowerCase())
      .join(' ')
    const spec =
      parseSpec(entity, tags?.tags ?? []) ??
      specFromName(entity, named?.value ?? '') ??
      (kindFromHover(hover) ? defaultCastSpec(entity, kindFromHover(hover)!) : null)
    if (!spec) return
    const caster = this.casters.get(entity) ?? this.upsert(entity, spec, new Set())
    this.fire(caster, 'pointer')
  }

  update(dt: number): void {
    const step = Math.min(0.05, Math.max(0, dt))
    const ability = getSceneAbilityVfxHost()
    if (this.pendingCast.size > 0) {
      for (const entity of [...this.pendingCast]) {
        const caster = this.casters.get(entity)
        if (!caster) {
          this.pendingCast.delete(entity)
          continue
        }
        if (this.fire(caster, 'spawn')) this.pendingCast.delete(entity)
      }
    }
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
    this.pendingCast.clear()
    this.firedOnce.clear()
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
    if (spec.mode === 'cast' && !this.firedOnce.has(entity)) {
      const pe = this.ecs.PointerEvents?.getOrNull(entity)
      if (!pe) this.pendingCast.add(entity)
    }
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
      const target = spec.targetDcl
        ? ` target=${spec.targetDcl.x},${spec.targetDcl.y},${spec.targetDcl.z}`
        : this.carTarget
          ? ' target=car'
          : ''
      clientDebugLog.log(
        'scene',
        `tag-vfx bind e${entity as number} ${spec.kind} mode=${spec.mode} ${aim}${start}${target} range=${spec.range}`,
        { alsoConsole: true }
      )
    }
    return caster
  }

  private refreshCarTarget(
    view: ProjectionView,
    GltfContainer: MirrorComponents['GltfContainer'],
    Transform: MirrorComponents['Transform']
  ): void {
    this.carTarget = null
    if (!GltfContainer) return
    for (const [entity] of view.getEntitiesWith(GltfContainer)) {
      const gltf = GltfContainer.getOrNull(entity) as { src?: string } | null
      if (!String(gltf?.src ?? '').toLowerCase().includes('anime-car')) continue
      const node = this.getNodes()?.get(entity)
      if (node) {
        node.updateWorldMatrix(true, false)
        node.getWorldPosition(_target)
        _target.y = 0
        this.carTarget = _target.clone()
        return
      }
      const tr = Transform?.getOrNull(entity) as { position?: { x: number; y: number; z: number } } | null
      if (tr?.position) {
        dclToThreePos(tr.position.x, 0, tr.position.z, _target)
        this.carTarget = _target.clone()
      }
      return
    }
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

  /** Impact point in Three space — authored target, else the scene's anime-car. */
  private resolveTargetThree(spec: TagSpec): THREE.Vector3 | null {
    if (spec.targetDcl) {
      dclToThreePos(spec.targetDcl.x, spec.targetDcl.y, spec.targetDcl.z, _target)
      _target.y = 0
      return _target
    }
    return this.carTarget
  }

  private fire(caster: Caster, reason: 'loop' | 'pointer' | 'spawn'): boolean {
    const nodes = this.getNodes()
    const node = nodes?.get(caster.spec.entity)
    if (!node && !caster.spec.originDcl && !caster.spec.dirDcl && !caster.spec.targetDcl && !this.carTarget) {
      return false
    }
    if (node) node.updateWorldMatrix(true, false)
    const origin = node
      ? this.resolveOrigin(caster.spec, node)
      : caster.spec.originDcl
        ? dclToThreePos(
            caster.spec.originDcl.x,
            caster.spec.originDcl.y,
            caster.spec.originDcl.z,
            _origin
          )
        : _origin.set(0, 0, 0)
    const impact = this.resolveTargetThree(caster.spec)
    let dir: THREE.Vector3
    let range = caster.spec.range
    if (impact) {
      _dir.copy(impact).sub(origin)
      _dir.y = 0
      range = Math.max(8, _dir.length())
      if (_dir.lengthSq() < 1e-8) _dir.set(0, 0, 1)
      dir = _dir.normalize()
    } else {
      dir = resolveDir(caster.spec, node)
    }
    caster.live?.dispose()
    caster.live = null

    const ability = getSceneAbilityVfxHost()
    if (ability) {
      const ok = ability.cast(caster.spec.kind, origin, dir, range)
      if (reason === 'spawn' || reason === 'pointer') this.firedOnce.add(caster.spec.entity)
      clientDebugLog.log(
        'scene',
        `tag-vfx ${ok ? caster.spec.kind : 'queued'} e${caster.spec.entity as number} ${reason} ` +
          `start=(${origin.x.toFixed(1)},${origin.y.toFixed(1)},${origin.z.toFixed(1)}) ` +
          `dir=(${dir.x.toFixed(2)},${dir.z.toFixed(2)}) range=${range.toFixed(1)}`,
        { alsoConsole: true }
      )
      return true
    }

    clientDebugLog.log(
      'scene',
      'tag-vfx no AbilityManager host — real ice cannot fire (World not ready)',
      { level: 'warn', alsoConsole: true }
    )
    return false
  }
}
