import type { Entity, IEngine } from '@dcl/ecs'
import * as components from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'
import { patchClearPlayerInputModifierBoundary } from './patchClearPlayerInputModifier'
import { patchEngineSystemLoopPartition } from './patchEngineSystemLoop'
import { patchInputModifierSdkSpread } from './patchInputModifierSdkSpread'
import { patchProjectileSweptHits } from './patchProjectileSweptHits'
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

/**
 * Bundled `@dcl/react-ecs` registration. Minifier renames the reconcile fn (`d`, `p`, …)
 * and sometimes the engine local — only the system name is stable.
 * Asset-pack `initAssetPacks` calls `createReactBasedUiSystem` again with ui unset —
 * second reconcile runs `update(null)` and/or the engine-loop partition kept only the
 * last `@dcl/react-ecs` (Dead Surge: asset-packs admin toolkit before its async
 * setUiRenderer → mount=0 forever).
 *
 * Never run heavy `/g` regexes over multi-MB sources. Locate `"@dcl/react-ecs"` /
 * `'@dcl/react-ecs'` (not `-ui-scale`) and rewrite only the nearby `.addSystem(...)`.
 *
 * Dead Surge (~13MB) ships pretty-printed react-ecs:
 *   `engine2.addSystem(ReactBasedUiSystem, 1e5, "@dcl/react-ecs")`
 * Compact minified planets use `,1e5,"@dcl/react-ecs")` — both must match.
 */
const REACT_ECS_NAME_MARKERS = ['"@dcl/react-ecs"', "'@dcl/react-ecs'"] as const

/** Compact minified: `setUiRenderer(a,b){n=a,o=b}` */
const SET_UI_RENDERER_RE =
  /setUiRenderer\((\w+),(\w+)\)\{(\w+)=\1,(\w+)=\2\}/g
/** Pretty-printed (Dead Surge): `setUiRenderer(ui, options) {\n  uiComponent2 = ui;\n  virtualSize = options;\n}` */
const SET_UI_RENDERER_PRETTY_RE =
  /setUiRenderer\((\w+),\s*(\w+)\)\s*\{\s*(\w+)\s*=\s*\1;\s*(\w+)\s*=\s*\2;?\s*\}/g
const ADD_UI_RENDERER_RE =
  /addUiRenderer\((\w+),(\w+),(\w+)\)\{(\w+)\.set\(\1,\{ui:\2,options:\3\}\)\}/g

/**
 * Closing `)` indices of `recv.addSystem(fn, …, "@dcl/react-ecs")` — skips ui-scale.
 */
function findReactEcsAddSystemCloseParens(code: string): number[] {
  const ends: number[] = []
  for (const marker of REACT_ECS_NAME_MARKERS) {
    let from = 0
    while (from < code.length) {
      const at = code.indexOf(marker, from)
      if (at < 0) break
      from = at + marker.length
      // `@dcl/react-ecs-ui-scale` shares the prefix — skip.
      if (code.startsWith('-ui-scale', from)) continue
      let j = from
      while (j < code.length && (code[j] === ' ' || code[j] === '\t' || code[j] === '\n' || code[j] === '\r')) {
        j++
      }
      if (code[j] !== ')') continue
      ends.push(j)
    }
  }
  return ends
}

/**
 * From the closing `)` of `addSystem(fn,1e5,"@dcl/react-ecs")`, walk back to the receiver
 * and rebuild with once-guard + fallback so a missing hook still registers.
 */
function patchOneReactEcsAddSystem(code: string, closeParenIdx: number): string | null {
  // closeParenIdx points at the final `)` of the addSystem call.
  // Expect: recv.addSystem(fn, 1e5, "@dcl/react-ecs")  (spaces optional)
  const i = closeParenIdx
  if (code[i] !== ')') return null
  let depth = 0
  let openParen = -1
  for (let j = i; j >= 0; j--) {
    const ch = code[j]!
    if (ch === ')') depth++
    else if (ch === '(') {
      depth--
      if (depth === 0) {
        openParen = j
        break
      }
    }
  }
  if (openParen < 0) return null
  // openParen is the `(` after addSystem — allow whitespace before `(`.
  const before = code.slice(Math.max(0, openParen - 24), openParen)
  const addSys = before.match(/(\w+)\.addSystem\s*$/)
  if (!addSys) return null
  const recv = addSys[1]!
  const callStart = openParen - addSys[0].length
  // Args: (fn, 1e5, "@dcl/react-ecs") or (fn,1e5,"@dcl/react-ecs")
  const args = code.slice(openParen + 1, i)
  const fnMatch = args.match(/^\s*(\w+)\s*,/)
  if (!fnMatch) return null
  const fn = fnMatch[1]!
  // Fallback keeps registration if the worker hook failed to install (never silent no-op).
  const replacement =
    `(globalThis.__THREEJS_UI_REACT_ECS_ONCE__||function(__f,__e){__e.addSystem(__f,1e5,"@dcl/react-ecs")})(${fn},${recv})`
  return code.slice(0, callStart) + replacement + code.slice(i + 1)
}

/**
 * Only the first react-ecs reconcile may register — later asset-pack createReactBasedUiSystem no-ops.
 * Returns patched source; `onStep` gets a hit count when provided via patchSceneBundle.
 */
function patchReactEcsOnceGuard(code: string): { code: string; patched: number } {
  if (!code.includes('@dcl/react-ecs')) return { code, patched: 0 }

  let out = code
  const ends = findReactEcsAddSystemCloseParens(out)
  if (!ends.length) return { code, patched: 0 }

  ends.sort((a, b) => b - a)
  let patched = 0
  let last = -1
  for (const end of ends) {
    if (end === last) continue
    last = end
    const next = patchOneReactEcsAddSystem(out, end)
    if (next) {
      out = next
      patched++
    }
  }
  return { code: out, patched }
}

function injectVirtualCanvasReport(optionsArg: string): string {
  return `try{if(${optionsArg}&&${optionsArg}.virtualWidth>0&&${optionsArg}.virtualHeight>0&&globalThis.__THREEJS_UI_VIRTUAL_CANVAS__)globalThis.__THREEJS_UI_VIRTUAL_CANVAS__(${optionsArg}.virtualWidth,${optionsArg}.virtualHeight)}catch(__err){}`
}

/** Patch ReactEcsRenderer setUiRenderer/addUiRenderer to report virtual canvas size to main. */
function patchUiVirtualCanvasHooks(code: string): string {
  if (!code.includes('setUiRenderer') && !code.includes('addUiRenderer')) return code
  let out = code
  if (code.includes('setUiRenderer')) {
    SET_UI_RENDERER_RE.lastIndex = 0
    out = out.replace(
      SET_UI_RENDERER_RE,
      (_match, entityArg, optionsArg, lhs, rhs) =>
        `setUiRenderer(${entityArg},${optionsArg}){${injectVirtualCanvasReport(optionsArg)}${lhs}=${entityArg},${rhs}=${optionsArg}}`
    )
    SET_UI_RENDERER_PRETTY_RE.lastIndex = 0
    out = out.replace(
      SET_UI_RENDERER_PRETTY_RE,
      (_match, entityArg, optionsArg, lhs, rhs) =>
        `setUiRenderer(${entityArg},${optionsArg}){${injectVirtualCanvasReport(optionsArg)}${lhs}=${entityArg};${rhs}=${optionsArg}}`
    )
  }
  if (out.includes('addUiRenderer')) {
    ADD_UI_RENDERER_RE.lastIndex = 0
    out = out.replace(
      ADD_UI_RENDERER_RE,
      (_match, entityArg, uiArg, optionsArg, mapVar) =>
        `addUiRenderer(${entityArg},${uiArg},${optionsArg}){${injectVirtualCanvasReport(optionsArg)}${mapVar}.set(${entityArg},{ui:${uiArg},options:${optionsArg}})}`
    )
  }
  return out
}

/** Default bundle patch — composite alias + safe engine capture (no checker strip). */
export function patchSceneBundle(code: string, onStep?: PatchSceneBundleStepLog): string {
  const runStep = (label: string, fn: () => string): string => {
    // Negative ms = "step starting" — worker can heartbeat before long work.
    onStep?.(`begin ${label}`, -1)
    const stepAt = performance.now()
    const out = fn()
    onStep?.(label, performance.now() - stepAt)
    return out
  }

  let out = runStep('composite alias', () => patchCompositeSrcAlias(code))

  out = runStep('theatre skip hooks', () => {
    const theatre = patchTheatreSkip(out)
    if (theatre.applied.length) {
      onStep?.(`theatre skip hooks (${theatre.applied.join(',')})`, 0)
    } else if (theatre.missed.length) {
      onStep?.(`theatre skip missed (${theatre.missed.join(',')})`, 0)
    }
    return theatre.code
  })

  out = runStep('addTransport capture', () => wrapAddTransportCalls(out, ADD_TRANSPORT_WRAP_LIMIT))
  out = runStep('react-ecs once guard', () => {
    const r = patchReactEcsOnceGuard(out)
    onStep?.(
      r.patched > 0
        ? `react-ecs once guard (patched ${r.patched})`
        : 'react-ecs once guard (missed — no addSystem sites)',
      0
    )
    return r.code
  })
  out = runStep('ui virtual canvas', () => patchUiVirtualCanvasHooks(out))

  out = runStep('engine ui system loop', () => {
    const before = out
    const next = patchEngineSystemLoopPartition(out)
    onStep?.(
      next !== before ? 'engine ui system loop (applied)' : 'engine ui system loop (missed)',
      0
    )
    return next
  })

  out = runStep('input modifier sdk guard', () => {
    const r = patchInputModifierSdkSpread(out)
    if (r.applied) onStep?.('input modifier sdk guard hook', 0)
    return r.code
  })

  out = runStep('clearPlayerInputModifier guard', () => {
    const r = patchClearPlayerInputModifierBoundary(out)
    if (r.applied) onStep?.('clearPlayerInputModifier guard hook', 0)
    return r.code
  })

  out = runStep('sdk onUpdate pollEvents boundary', () => {
    const r = patchSdkOnUpdatePollEventsBoundary(out)
    if (r.applied) onStep?.('sdk onUpdate pollEvents boundary', 0)
    return r.code
  })

  out = runStep('photo mural optional-chain', () => {
    const r = patchPhotoMuralOptionalChain(out)
    if (r.applied) onStep?.(`photo mural optional-chain (${r.replacements})`, 0)
    return r.code
  })

  out = runStep('projectile swept hits', () => {
    const r = patchProjectileSweptHits(out)
    if (r.applied) {
      onStep?.(
        `projectile swept hits (hits=${r.replacements} origins=${r.originSnapshots})`,
        0
      )
    }
    return r.code
  })

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
