import { componentNumberFromName } from '@dcl/ecs/dist/components/component-number'
import { Schemas } from '@dcl/ecs'
import type { IEngine, LastWriteWinElementSetComponentDefinition } from '@dcl/ecs'

/** Locked component name — hashed id > 2048 (same class as Tags). */
export const TJS_COMPONENT_NAME = 'tjs'
export const TJS_COMPONENT_ID = componentNumberFromName(TJS_COMPONENT_NAME)

export type TjsKind = 'shader' | 'texture' | 'camera' | 'projection'

export type TjsValue = {
  kind: string
  name: string
  sync: boolean
  enabled: boolean
  path: string
  ox: number
  oy: number
  oz: number
  dx: number
  dy: number
  dz: number
  dist: number
  camera: number
}

export const tjsSpec = {
  kind: Schemas.String,
  name: Schemas.String,
  sync: Schemas.Boolean,
  enabled: Schemas.Boolean,
  path: Schemas.String,
  ox: Schemas.Float,
  oy: Schemas.Float,
  oz: Schemas.Float,
  dx: Schemas.Float,
  dy: Schemas.Float,
  dz: Schemas.Float,
  dist: Schemas.Float,
  camera: Schemas.Int
} as const

export type TjsComponent = LastWriteWinElementSetComponentDefinition<TjsValue>

export function emptyTjsValue(): TjsValue {
  return {
    kind: '',
    name: '',
    sync: false,
    enabled: false,
    path: '',
    ox: 0,
    oy: 0,
    oz: 0,
    dx: 0,
    dy: 0,
    dz: 0,
    dist: 0,
    camera: 0
  }
}

/** Host mirror + worker guest must share this definition so CRDT ids match. */
export function defineTjsComponent(engine: IEngine): TjsComponent {
  return engine.defineComponent(TJS_COMPONENT_NAME, tjsSpec, emptyTjsValue()) as TjsComponent
}

/** Idempotent — scene may already call defineComponent('tjs', …) in its bundle. */
export function ensureTjsComponent(engine: IEngine): TjsComponent {
  const named = (engine as IEngine & {
    getComponentOrNull?: (name: string) => TjsComponent | null
  }).getComponentOrNull?.(TJS_COMPONENT_NAME)
  if (named) return named as TjsComponent
  for (const component of engine.componentsIter()) {
    const name = (component as { componentName?: string }).componentName ?? ''
    if (name === TJS_COMPONENT_NAME || name.endsWith(`::${TJS_COMPONENT_NAME}`)) {
      return component as TjsComponent
    }
  }
  return defineTjsComponent(engine)
}

export function defaultShaderPath(name: string): string {
  const key = name.trim().toLowerCase()
  if (key === 'ice') return 'assets/shaders/IceAbility.js'
  if (key === 'meteor' || key === 'cinder' || key === 'cinderfall') return 'assets/shaders/MeteorAbility.js'
  if (key === 'hail' || key === 'hailwraith') return 'assets/shaders/HailAbility.js'
  return ''
}

export function resolveTjsShaderPath(row: Pick<TjsValue, 'name' | 'path'>): string {
  const authored = row.path.trim()
  if (authored) return authored
  return defaultShaderPath(row.name)
}

export function tjsValueFingerprint(row: TjsValue): string {
  return [
    row.kind,
    row.name,
    row.sync,
    row.enabled,
    row.path,
    row.ox,
    row.oy,
    row.oz,
    row.dx,
    row.dy,
    row.dz,
    row.dist,
    row.camera
  ].join('|')
}
