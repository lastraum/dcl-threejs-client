import type { Entity, IEngine } from '@dcl/ecs'
import * as components from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { patchClearPlayerInputModifierBoundary } from './patchClearPlayerInputModifier'
import { patchEngineSystemLoopPartition } from './patchEngineSystemLoop'
import { patchInputModifierSdkSpread } from './patchInputModifierSdkSpread'
import { patchSdkOnUpdatePollEventsBoundary } from './patchSdkOnUpdatePollEvents'
import { patchPhotoMuralOptionalChain } from './photoMuralPatch'
import { patchTheatreSkip } from './theatreSkipPatch'

const STOCK_CHECKER_RE = /Missing MeshCollider component on entity/

/** Block bundled @dcl/sdk checker if a scene re-registers it after eval. */
function guardAddSystemFromStockChecker(engine: IEngine): void {
  const add = engine.addSystem.bind(engine)
  engine.addSystem = (fn, priority, name) => {
    if (typeof name === 'string' && STOCK_CHECKER_RE.test(name)) return
    if (STOCK_CHECKER_RE.test(fn.toString())) return
    add(fn, priority, name)
  }
}

/**
 * Scene bundles embed @dcl/sdk and call `pointerEventColliderChecker(engine)` at init.
 * Strip that call in `evaluateSceneBundle` — the public engine API has no `getSystems()`.
 */
const PREREGISTER_CALL =
  'try{globalThis.__THREEJS_PREREGISTER_RENDERER_COMPONENTS__&&globalThis.__THREEJS_PREREGISTER_RENDERER_COMPONENTS__(__e)}catch(__err){}'

const CAPTURE_ENGINE =
  `(function(__e){if(__e&&typeof __e.update==="function"&&typeof __e.addSystem==="function"){${PREREGISTER_CALL}globalThis.__THREEJS_SCENE_ENGINE__=__e}})`

/** Minified bundles call `ae.addTransport(jP)` — capture scene engine at renderer registration. */
const CAPTURE_ADD_TRANSPORT =
  `(function(__e,__t){if(__e&&typeof __e.update==="function"&&typeof __e.addSystem==="function"){${PREREGISTER_CALL}globalThis.__THREEJS_SCENE_ENGINE__=__e}return __e.addTransport(__t)})`

const CHECKER_CALL_NEEDLE = 'pointerEventColliderChecker('
const ADD_TRANSPORT_NEEDLE = '.addTransport('
/** Wrap every scene registration site — string-aware scan is cheap vs missing the scene engine. */
const ADD_TRANSPORT_WRAP_LIMIT = Number.POSITIVE_INFINITY

type AddTransportCallSite = { receiver: string; arg: string; start: number; end: number }

function skipQuotedString(code: string, start: number, quote: "'" | '"'): number {
  let i = start + 1
  while (i < code.length) {
    const ch = code[i]!
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === quote) return i + 1
    i++
  }
  return code.length
}

/** Skip `${...}` inside a template literal — nested strings/templates are real tokens. */
function skipTemplateExpression(code: string, start: number): number {
  let i = start + 2
  let depth = 1
  while (i < code.length && depth > 0) {
    const ch = code[i]!
    const next = code[i + 1]
    if (ch === '/' && next === '/') {
      i += 2
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < code.length - 1) {
        if (code[i] === '*' && code[i + 1] === '/') {
          i += 2
          break
        }
        i++
      }
      continue
    }
    if (ch === "'") {
      i = skipQuotedString(code, i, "'")
      continue
    }
    if (ch === '"') {
      i = skipQuotedString(code, i, '"')
      continue
    }
    if (ch === '`') {
      i = skipTemplateLiteral(code, i)
      continue
    }
    if (ch === '{') depth++
    else if (ch === '}') depth--
    i++
  }
  return i
}

function skipTemplateLiteral(code: string, start: number): number {
  let i = start + 1
  while (i < code.length) {
    const ch = code[i]!
    const next = code[i + 1]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '`') return i + 1
    if (ch === '$' && next === '{') {
      i = skipTemplateExpression(code, i)
      continue
    }
    i++
  }
  return code.length
}

/** Walk source once; invoke `onMatch(i)` for each `needle` at index `i` outside strings/comments. */
function forEachNeedleOutsideStrings(code: string, needle: string, onMatch: (index: number) => void): void {
  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    const next = code[i + 1]
    if (ch === '/' && next === '/') {
      i += 2
      while (i < code.length && code[i] !== '\n') i++
      continue
    }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < code.length - 1) {
        if (code[i] === '*' && code[i + 1] === '/') {
          i += 2
          break
        }
        i++
      }
      continue
    }
    if (ch === "'") {
      i = skipQuotedString(code, i, "'") - 1
      continue
    }
    if (ch === '"') {
      i = skipQuotedString(code, i, '"') - 1
      continue
    }
    if (ch === '`') {
      i = skipTemplateLiteral(code, i) - 1
      continue
    }
    if (code.startsWith(needle, i)) {
      onMatch(i)
      i += needle.length - 1
    }
  }
}

export function stripBundledPointerEventColliderChecker(code: string): string {
  if (!code.includes(CHECKER_CALL_NEEDLE)) return code

  const sites: { start: number; end: number; arg: string }[] = []
  forEachNeedleOutsideStrings(code, CHECKER_CALL_NEEDLE, (idx) => {
    const argStart = idx + CHECKER_CALL_NEEDLE.length
    let argEnd = argStart
    while (argEnd < code.length && /[0-9a-zA-Z_$]/.test(code[argEnd]!)) argEnd++
    if (argEnd >= code.length || code[argEnd] !== ')') return
    const arg = code.slice(argStart, argEnd)
    if (!/^[a-zA-Z_$][\w$]*(?:\.engine)?$/.test(arg)) return
    sites.push({ start: idx, end: argEnd + 1, arg })
  })

  if (!sites.length) return code

  let out = code
  for (let i = sites.length - 1; i >= 0; i--) {
    const site = sites[i]!
    const replacement = `${CAPTURE_ENGINE}(${site.arg});(void 0)`
    out = out.slice(0, site.start) + replacement + out.slice(site.end)
  }
  return out
}

/**
 * Some deploys inline composites as `assets/scene/main.composite` while onStart calls
 * `getCompositeOrNull("main.composite")` — alias lookup so composite instancing runs (opbadge).
 */
function patchCompositeSrcAlias(code: string): string {
  if (!code.includes('getCompositeOrNull')) return code
  return code.replace(
    /getCompositeOrNull\((\w+)(?:,(\w+))?\)\{let (\w+)=(\w+)\[(\w+)\]/,
    (_, arg0, arg1, varName, tableName, key) =>
      `getCompositeOrNull(${arg0}${arg1 ? `,${arg1}` : ''}){let ${varName}=${tableName}[${key}]||${tableName}["assets/scene/"+${key}]`
  )
}

function parseSimpleAddTransportAt(code: string, dotIndex: number): AddTransportCallSite | null {
  let recvStart = dotIndex - 1
  while (recvStart >= 0 && /[0-9a-zA-Z_$]/.test(code[recvStart]!)) recvStart--
  recvStart++
  const receiver = code.slice(recvStart, dotIndex)
  if (!receiver || !/^[a-zA-Z_$][\w$]*$/.test(receiver)) return null

  const argStart = dotIndex + ADD_TRANSPORT_NEEDLE.length
  let argEnd = argStart
  while (argEnd < code.length && /[0-9a-zA-Z_$]/.test(code[argEnd]!)) argEnd++
  const arg = code.slice(argStart, argEnd)
  if (!arg || argEnd >= code.length || code[argEnd] !== ')') return null

  return { receiver, arg, start: recvStart, end: argEnd + 1 }
}

const SIMPLE_ADD_TRANSPORT_RE = /([a-zA-Z_$][\w$]*)\.addTransport\(([a-zA-Z_$][\w$]*)\)/g

function findSimpleAddTransportCallsRegexFallback(code: string): AddTransportCallSite[] {
  if (!code.includes(ADD_TRANSPORT_NEEDLE)) return []
  const out: AddTransportCallSite[] = []
  for (const match of code.matchAll(SIMPLE_ADD_TRANSPORT_RE)) {
    const receiver = match[1]!
    const dotIndex = match.index! + receiver.length
    const parsed = parseSimpleAddTransportAt(code, dotIndex)
    if (parsed) out.push(parsed)
  }
  return out
}

function findSimpleAddTransportCalls(code: string): AddTransportCallSite[] {
  const out: AddTransportCallSite[] = []
  forEachNeedleOutsideStrings(code, ADD_TRANSPORT_NEEDLE, (dotIndex) => {
    const parsed = parseSimpleAddTransportAt(code, dotIndex)
    if (parsed) out.push(parsed)
  })
  if (out.length) return out
  // React-heavy deploy bundles (RickRoll bin/index.js) can desync the string-aware scan
  // across megabyte-scale template literals — fall back to the last simple addTransport site.
  return findSimpleAddTransportCallsRegexFallback(code)
}

/** Wrap the last N scene `engine.addTransport(renderer)` calls — outside strings only. */
function wrapAddTransportCalls(code: string, limit: number): string {
  if (!code.includes(ADD_TRANSPORT_NEEDLE)) return code
  const calls = findSimpleAddTransportCalls(code)
  if (!calls.length) return code

  const toWrap = calls.slice(-limit)
  let patched = code
  for (let i = toWrap.length - 1; i >= 0; i--) {
    const call = toWrap[i]!
    const replacement = `${CAPTURE_ADD_TRANSPORT}(${call.receiver},${call.arg})`
    patched = patched.slice(0, call.start) + replacement + patched.slice(call.end)
  }
  return patched
}

export type PatchSceneBundleStepLog = (step: string, ms: number) => void

const REACT_ECS_ADD_RE = /e\.addSystem\(d,1e5,"@dcl\/react-ecs"\)/g

const SET_UI_RENDERER_RE =
  /setUiRenderer\((\w+),(\w+)\)\{(\w+)=\1,(\w+)=\2\}/g
const ADD_UI_RENDERER_RE =
  /addUiRenderer\((\w+),(\w+),(\w+)\)\{(\w+)\.set\(\1,\{ui:\2,options:\3\}\)\}/g

/** Only the scene react-ecs renderer may register — asset packs call sw() again with n unset. */
function patchReactEcsOnceGuard(code: string): string {
  if (!code.includes('addSystem(d,1e5,"@dcl/react-ecs")')) return code
  return code.replace(
    REACT_ECS_ADD_RE,
    'globalThis.__THREEJS_UI_REACT_ECS_ONCE__&&globalThis.__THREEJS_UI_REACT_ECS_ONCE__(d,e)'
  )
}

/** Patch ReactEcsRenderer setUiRenderer/addUiRenderer to report virtual canvas size to main. */
function patchUiVirtualCanvasHooks(code: string): string {
  let out = code
  out = out.replace(
    SET_UI_RENDERER_RE,
    (_match, entityArg, optionsArg, lhs, rhs) =>
      `setUiRenderer(${entityArg},${optionsArg}){try{if(${optionsArg}&&${optionsArg}.virtualWidth>0&&${optionsArg}.virtualHeight>0&&globalThis.__THREEJS_UI_VIRTUAL_CANVAS__)globalThis.__THREEJS_UI_VIRTUAL_CANVAS__(${optionsArg}.virtualWidth,${optionsArg}.virtualHeight)}catch(__err){}${lhs}=${entityArg},${rhs}=${optionsArg}}`
  )
  out = out.replace(
    ADD_UI_RENDERER_RE,
    (_match, entityArg, uiArg, optionsArg, mapVar) =>
      `addUiRenderer(${entityArg},${uiArg},${optionsArg}){try{if(${optionsArg}&&${optionsArg}.virtualWidth>0&&${optionsArg}.virtualHeight>0&&globalThis.__THREEJS_UI_VIRTUAL_CANVAS__)globalThis.__THREEJS_UI_VIRTUAL_CANVAS__(${optionsArg}.virtualWidth,${optionsArg}.virtualHeight)}catch(__err){}${mapVar}.set(${entityArg},{ui:${uiArg},options:${optionsArg}})}`
  )
  return out
}

/** Default bundle patch — composite alias + safe engine capture (no checker strip). */
export function patchSceneBundle(code: string, onStep?: PatchSceneBundleStepLog): string {
  let stepAt = performance.now()
  let out = patchCompositeSrcAlias(code)
  onStep?.('composite alias', performance.now() - stepAt)
  stepAt = performance.now()
  const theatre = patchTheatreSkip(out)
  out = theatre.code
  if (theatre.applied.length) {
    onStep?.(`theatre skip hooks (${theatre.applied.join(',')})`, performance.now() - stepAt)
  } else if (theatre.missed.length) {
    onStep?.(`theatre skip missed (${theatre.missed.join(',')})`, performance.now() - stepAt)
  }
  stepAt = performance.now()
  out = wrapAddTransportCalls(out, ADD_TRANSPORT_WRAP_LIMIT)
  onStep?.('addTransport capture', performance.now() - stepAt)
  stepAt = performance.now()
  out = patchReactEcsOnceGuard(out)
  onStep?.('react-ecs once guard', performance.now() - stepAt)
  stepAt = performance.now()
  out = patchUiVirtualCanvasHooks(out)
  onStep?.('ui virtual canvas', performance.now() - stepAt)
  stepAt = performance.now()
  const beforeEngineLoop = out
  out = patchEngineSystemLoopPartition(out)
  onStep?.(
    out !== beforeEngineLoop ? 'engine ui system loop (applied)' : 'engine ui system loop (missed)',
    performance.now() - stepAt
  )
  stepAt = performance.now()
  const inputModifierSdk = patchInputModifierSdkSpread(out)
  out = inputModifierSdk.code
  if (inputModifierSdk.applied) {
    onStep?.('input modifier sdk guard hook', performance.now() - stepAt)
  }
  stepAt = performance.now()
  const clearPlayerIm = patchClearPlayerInputModifierBoundary(out)
  out = clearPlayerIm.code
  if (clearPlayerIm.applied) {
    onStep?.('clearPlayerInputModifier guard hook', performance.now() - stepAt)
  }
  stepAt = performance.now()
  const pollEventsBoundary = patchSdkOnUpdatePollEventsBoundary(out)
  out = pollEventsBoundary.code
  if (pollEventsBoundary.applied) {
    onStep?.('sdk onUpdate pollEvents boundary', performance.now() - stepAt)
  }
  stepAt = performance.now()
  const photoMural = patchPhotoMuralOptionalChain(out)
  out = photoMural.code
  if (photoMural.applied) {
    onStep?.(`photo mural optional-chain (${photoMural.replacements})`, performance.now() - stepAt)
  }
  return out
}

/** Full patch including checker strip — use only as compile fallback. */
export function patchSceneBundleWithCheckerStrip(code: string, onStep?: PatchSceneBundleStepLog): string {
  let stepAt = performance.now()
  let out = stripBundledPointerEventColliderChecker(code)
  onStep?.('strip checker', performance.now() - stepAt)
  stepAt = performance.now()
  out = patchCompositeSrcAlias(out)
  onStep?.('composite alias', performance.now() - stepAt)
  return out
}

/** True when `entity` carries geometry the client pointer raycast can hit. */
function entityHasPointerCollider(
  entity: Entity,
  MeshCollider: ReturnType<typeof components.MeshCollider>,
  GltfContainer: ReturnType<typeof generated.GltfContainer>,
  MeshRenderer: ReturnType<typeof components.MeshRenderer>
): boolean {
  if (GltfContainer.has(entity)) return true
  if (MeshCollider.has(entity)) return true
  if (MeshRenderer.has(entity)) return true
  return false
}

/** BFS descendants — asset-pack Triggers put PointerEvents on parents, colliders on children. */
function descendantHasPointerCollider(
  entity: Entity,
  childrenByParent: Map<Entity, Entity[]>,
  MeshCollider: ReturnType<typeof components.MeshCollider>,
  GltfContainer: ReturnType<typeof generated.GltfContainer>,
  MeshRenderer: ReturnType<typeof components.MeshRenderer>
): boolean {
  const stack = [...(childrenByParent.get(entity) ?? [])]
  while (stack.length) {
    const current = stack.pop()!
    if (entityHasPointerCollider(current, MeshCollider, GltfContainer, MeshRenderer)) return true
    const children = childrenByParent.get(current)
    if (children?.length) stack.push(...children)
  }
  return false
}

/** Walk parent chain from each collider/mesh entity → mark PointerEvents ancestors as supported. */
function buildPointerEventsWithColliderSupport(
  engine: IEngine,
  PointerEvents: ReturnType<typeof generated.PointerEvents>,
  Transform: ReturnType<typeof components.Transform>,
  MeshCollider: ReturnType<typeof components.MeshCollider>,
  GltfContainer: ReturnType<typeof generated.GltfContainer>,
  MeshRenderer: ReturnType<typeof components.MeshRenderer>
): Set<Entity> {
  const supported = new Set<Entity>()
  const visitAncestors = (start: Entity): void => {
    let current: Entity | undefined = start
    const seen = new Set<Entity>()
    while (current !== undefined && !seen.has(current)) {
      seen.add(current)
      if (PointerEvents.has(current)) {
        supported.add(current)
        return
      }
      const parent = Transform.getOrNull(current)?.parent
      if (parent === undefined) return
      current = parent as Entity
    }
  }

  for (const [entity] of engine.getEntitiesWith(MeshCollider)) visitAncestors(entity)
  for (const [entity] of engine.getEntitiesWith(GltfContainer)) visitAncestors(entity)
  for (const [entity] of engine.getEntitiesWith(MeshRenderer)) visitAncestors(entity)
  return supported
}

/**
 * Replace @dcl/ecs `pointerEventColliderChecker` with a descendant-aware variant.
 *
 * Asset-pack Triggers (RickRoll, etc.) register `PointerEvents` on a parent entity
 * while `MeshCollider` lives on a child — the stock SDK checker only inspects the
 * same entity and spams false "Missing MeshCollider" warnings.
 */
export function installPointerEventColliderChecker(engine: IEngine): void {
  const PointerEvents = generated.PointerEvents(engine)
  const MeshCollider = components.MeshCollider(engine)
  const GltfContainer = generated.GltfContainer(engine)
  const MeshRenderer = components.MeshRenderer(engine)
  const UiTransform = generated.UiTransform(engine)
  const Transform = components.Transform(engine)

  guardAddSystemFromStockChecker(engine)

  const alreadyShown = new Set<Entity>()
  let timer = 0

  function buildChildrenByParent(): Map<Entity, Entity[]> {
    const childrenByParent = new Map<Entity, Entity[]>()
    for (const [entity] of engine.getEntitiesWith(Transform)) {
      const parent = Transform.get(entity).parent
      if (parent === undefined) continue
      let list = childrenByParent.get(parent)
      if (!list) {
        list = []
        childrenByParent.set(parent, list)
      }
      list.push(entity)
    }
    return childrenByParent
  }

  function pointerEventsColliderSupported(
    entity: Entity,
    childrenByParent: Map<Entity, Entity[]>,
    supportedByAncestors: Set<Entity>
  ): boolean {
    if (supportedByAncestors.has(entity)) return true
    if (entityHasPointerCollider(entity, MeshCollider, GltfContainer, MeshRenderer)) return true
    return descendantHasPointerCollider(entity, childrenByParent, MeshCollider, GltfContainer, MeshRenderer)
  }

  function threejsPointerEventColliderChecker(dt: number): void {
    timer += dt
    if (timer <= 10) return
    timer = 0

    const childrenByParent = buildChildrenByParent()
    const supportedByAncestors = buildPointerEventsWithColliderSupport(
      engine,
      PointerEvents,
      Transform,
      MeshCollider,
      GltfContainer,
      MeshRenderer
    )

    for (const [entity] of engine.getEntitiesWith(PointerEvents)) {
      if (alreadyShown.has(entity)) continue
      if (UiTransform.has(entity)) continue
      if (pointerEventsColliderSupported(entity, childrenByParent, supportedByAncestors)) continue
      // Asset-pack / composite Triggers: PointerEvents on parent, colliders on instanced children.
      if ((childrenByParent.get(entity)?.length ?? 0) > 0) continue

      alreadyShown.add(entity)
      console.log(
        `⚠️ Missing MeshCollider component on entity ${entity}. Add a MeshCollider to the entity so it can be clickeable by the player.
See https://docs.decentraland.org/creator/development-guide/sdk7/colliders/#pointer-blocking`
      )
    }
  }

  engine.addSystem(threejsPointerEventColliderChecker)
}
