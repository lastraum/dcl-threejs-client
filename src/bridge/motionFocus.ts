import type { Entity } from '@dcl/ecs'
import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'

const DEFAULT_BLIMP_PATTERN = 'blimp|propeller|prop_|idle_fly|zeppelin|airship'

function readSearchParams(): URLSearchParams | null {
  try {
    if (typeof location === 'undefined') return null
    return new URLSearchParams(location.search)
  } catch {
    return null
  }
}

/** `?blimpdebug` or `?motionfocus=blimp|prop` — filter motion logs to matching GLTF paths / hierarchy. */
export function getMotionFocusPattern(): RegExp | null {
  const params = readSearchParams()
  if (params?.has('blimpdebug')) {
    return new RegExp(DEFAULT_BLIMP_PATTERN, 'i')
  }
  const custom = params?.get('motionfocus')?.trim()
  if (custom) {
    try {
      return new RegExp(custom, 'i')
    } catch {
      console.warn('[motion] invalid motionfocus regex — using blimp default')
      return new RegExp(DEFAULT_BLIMP_PATTERN, 'i')
    }
  }
  try {
    const stored = localStorage.getItem('motionfocus')?.trim()
    if (stored) return new RegExp(stored, 'i')
  } catch {
    /* ignore */
  }
  return null
}

export function isMotionFocusActive(): boolean {
  return getMotionFocusPattern() != null
}

export function matchesMotionFocusSrc(src: string | undefined | null): boolean {
  const pattern = getMotionFocusPattern()
  if (!pattern || !src) return false
  return pattern.test(src)
}

/** Entity matches focus via own GltfContainer or up to 8 transform parents. */
export function entityMatchesMotionFocus(
  entity: Entity,
  ecs: Pick<MirrorComponents, 'GltfContainer' | 'Transform'>,
  view: Pick<ProjectionView, 'RootEntity'>
): boolean {
  const { GltfContainer, Transform } = ecs
  if (GltfContainer.has(entity) && matchesMotionFocusSrc(GltfContainer.get(entity).src)) {
    return true
  }
  let cur = entity
  for (let depth = 0; depth < 8; depth++) {
    if (!Transform.has(cur)) break
    const parent = Transform.get(cur).parent as Entity
    if (!parent || parent === view.RootEntity) break
    cur = parent
    if (GltfContainer.has(cur) && matchesMotionFocusSrc(GltfContainer.get(cur).src)) {
      return true
    }
  }
  return false
}

function gltfSrc(ecs: MirrorComponents, entity: Entity): string {
  return ecs.GltfContainer.has(entity) ? ecs.GltfContainer.get(entity).src : ''
}

function tweenMode(ecs: MirrorComponents, entity: Entity): string {
  if (!ecs.Tween.has(entity)) return '-'
  const tween = ecs.Tween.get(entity)
  const mode = tween.mode
  const playing = tween.playing !== false ? 'play' : 'stop'
  const dur = `${tween.duration}ms`
  if (mode?.$case === 'rotateContinuous') {
    return `rotateContinuous(${playing},spd=${mode.rotateContinuous.speed ?? '?'},${dur})`
  }
  if (mode?.$case === 'rotate') {
    return `rotate(${playing},${dur})`
  }
  return `${mode?.$case ?? '?'}(${playing},${dur})`
}

let cachedBlimpPivot: Entity | null = null

export function resetBlimpPivotCache(): void {
  cachedBlimpPivot = null
}

/** Parent entity of the `blimp.glb` GltfContainer (orbit pivot). */
export function resolveBlimpPivot(ecs: MirrorComponents, view: ProjectionView): Entity | null {
  if (cachedBlimpPivot != null) return cachedBlimpPivot
  for (const [entity] of view.getEntitiesWith(ecs.GltfContainer)) {
    if (!matchesMotionFocusSrc(gltfSrc(ecs, entity))) continue
    if (!ecs.Transform.has(entity)) continue
    const parent = ecs.Transform.get(entity).parent as Entity
    if (parent) {
      cachedBlimpPivot = parent
      return parent
    }
  }
  return null
}

function collectDescendants(
  root: Entity,
  ecs: Pick<MirrorComponents, 'Transform'>,
  view: ProjectionView
): Entity[] {
  const out: Entity[] = []
  for (const [entity] of view.getEntitiesWith(ecs.Transform)) {
    if (ecs.Transform.get(entity).parent !== root) continue
    out.push(entity, ...collectDescendants(entity, ecs, view))
  }
  return out
}

/** True when entity is the blimp pivot or any transform child under it. */
export function isInBlimpSubtree(
  entity: Entity,
  ecs: MirrorComponents,
  view: Pick<ProjectionView, 'RootEntity'>
): boolean {
  const pivot = resolveBlimpPivot(ecs, view as ProjectionView)
  if (pivot) {
    let cur: Entity = entity
    for (let depth = 0; depth < 16; depth++) {
      if (cur === pivot) return true
      if (!ecs.Transform.has(cur)) break
      const parent = ecs.Transform.get(cur).parent as Entity
      if (!parent || parent === view.RootEntity) break
      cur = parent
    }
  }
  return entityMatchesMotionFocus(entity, ecs, view)
}

function animatorSummary(ecs: MirrorComponents, entity: Entity): string {
  if (!ecs.Animator.has(entity)) return '-'
  const states = ecs.Animator.get(entity).states ?? []
  const playing = states
    .filter((s) => s.playing !== false && s.clip)
    .map((s) => s.clip)
    .join(',')
  return playing || '(none playing)'
}

/** One-shot ECS report for blimp / propeller debugging — call when scene is up. */
export function dumpMotionFocusReport(
  ecs: MirrorComponents,
  view: ProjectionView,
  options?: { hasSceneNode?: (entity: Entity) => boolean }
): void {
  const pattern = getMotionFocusPattern()
  if (!pattern) return

  const hits = new Set<Entity>()
  for (const [entity] of view.getEntitiesWith(ecs.GltfContainer)) {
    if (matchesMotionFocusSrc(gltfSrc(ecs, entity))) hits.add(entity)
  }
  for (const [entity] of view.getEntitiesWith(ecs.Tween)) {
    if (entityMatchesMotionFocus(entity, ecs, view)) hits.add(entity)
  }
  for (const [entity] of view.getEntitiesWith(ecs.Animator)) {
    if (entityMatchesMotionFocus(entity, ecs, view)) hits.add(entity)
  }

  const rotateContinuous: string[] = []
  for (const [entity] of view.getEntitiesWith(ecs.Tween)) {
    const t = ecs.Tween.get(entity)
    if (t.mode?.$case !== 'rotateContinuous') continue
    const src = gltfSrc(ecs, entity) || '(no GltfContainer)'
    const parent = ecs.Transform.has(entity) ? ecs.Transform.get(entity).parent : 0
    const node = options?.hasSceneNode?.(entity) ? 'yes' : 'no'
    const spd = t.mode?.$case === 'rotateContinuous' ? t.mode.rotateContinuous.speed : '?'
    rotateContinuous.push(`  ${entity} · ${src} · parent ${parent} · node ${node} · spd ${spd ?? '?'}`)
  }

  const focusLines: string[] = []
  for (const entity of [...hits].sort((a, b) => a - b)) {
    const src = gltfSrc(ecs, entity) || '(no GltfContainer)'
    const parent = ecs.Transform.has(entity) ? ecs.Transform.get(entity).parent : 0
    const node = options?.hasSceneNode?.(entity) ? 'yes' : 'no'
    const seq = ecs.TweenSequence.has(entity) ? 'yes' : 'no'
    focusLines.push(
      `  ${entity} · ${src} · parent ${parent} · node ${node} · tween ${tweenMode(ecs, entity)} · animator ${animatorSummary(ecs, entity)} · TweenSequence ${seq}`
    )
  }

  const pivot = resolveBlimpPivot(ecs, view)
  const subtreeLines: string[] = []
  if (pivot) {
    const subtree = [pivot, ...collectDescendants(pivot, ecs, view)]
    for (const entity of subtree) {
      const src = gltfSrc(ecs, entity) || '(no GltfContainer)'
      const parent = ecs.Transform.has(entity) ? ecs.Transform.get(entity).parent : 0
      const node = options?.hasSceneNode?.(entity) ? 'yes' : 'no'
      const seq = ecs.TweenSequence.has(entity) ? 'yes' : 'no'
      subtreeLines.push(
        `  ${entity} · ${src} · parent ${parent} · node ${node} · tween ${tweenMode(ecs, entity)} · animator ${animatorSummary(ecs, entity)} · TweenSequence ${seq}`
      )
    }
  }

  const rotateTweens: string[] = []
  for (const [entity] of view.getEntitiesWith(ecs.Tween)) {
    const t = ecs.Tween.get(entity)
    if (t.mode?.$case !== 'rotate') continue
    const src = gltfSrc(ecs, entity) || '(no GltfContainer)'
    const parent = ecs.Transform.has(entity) ? ecs.Transform.get(entity).parent : 0
    rotateTweens.push(`  ${entity} · ${src} · parent ${parent} · ${tweenMode(ecs, entity)}`)
  }

  const message = [
    `Motion focus report — /${pattern.source}/`,
    `GltfContainer matches: ${focusLines.length}`,
    ...focusLines,
    pivot ? `Blimp pivot ${pivot} — full subtree (${subtreeLines.length} entities):` : 'Blimp pivot: (not found)',
    ...(pivot ? subtreeLines : []),
    `All rotate tweens (${rotateTweens.length}) — finite spin candidates:`,
    ...(rotateTweens.length ? rotateTweens.slice(0, 40) : ['  (none)']),
    rotateTweens.length > 40 ? `  … +${rotateTweens.length - 40} more` : '',
    `All rotateContinuous tweens (${rotateContinuous.length}):`,
    ...(rotateContinuous.length ? rotateContinuous : ['  (none)'])
  ]
    .filter(Boolean)
    .join('\n')

  clientDebugLog.log('motion', message, { level: 'info', alsoConsole: true })
  console.info('[motion]', message)
}