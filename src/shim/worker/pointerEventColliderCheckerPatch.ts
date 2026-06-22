import type { Entity, IEngine } from '@dcl/ecs'
import * as components from '@dcl/ecs/dist/components'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen'

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

/** Walk source once; invoke `onMatch(i)` for each `needle` at index `i` outside strings/comments. */
function forEachNeedleOutsideStrings(code: string, needle: string, onMatch: (index: number) => void): void {
  let inSingle = false
  let inDouble = false
  let inTemplate = false
  let inLineComment = false
  let inBlockComment = false

  for (let i = 0; i < code.length; i++) {
    const ch = code[i]!
    const next = code[i + 1]

    if (inLineComment) {
      if (ch === '\n') inLineComment = false
      continue
    }
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        inBlockComment = false
        i++
      }
      continue
    }
    if (inSingle) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === "'") inSingle = false
      continue
    }
    if (inDouble) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '"') inDouble = false
      continue
    }
    if (inTemplate) {
      if (ch === '\\') {
        i++
        continue
      }
      if (ch === '`') inTemplate = false
      continue
    }

    if (ch === '/' && next === '/') {
      inLineComment = true
      i++
      continue
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true
      i++
      continue
    }
    if (ch === "'") {
      inSingle = true
      continue
    }
    if (ch === '"') {
      inDouble = true
      continue
    }
    if (ch === '`') {
      inTemplate = true
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

function findSimpleAddTransportCalls(code: string): AddTransportCallSite[] {
  const out: AddTransportCallSite[] = []
  forEachNeedleOutsideStrings(code, ADD_TRANSPORT_NEEDLE, (dotIndex) => {
    const parsed = parseSimpleAddTransportAt(code, dotIndex)
    if (parsed) out.push(parsed)
  })
  return out
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

/** Default bundle patch — composite alias + safe engine capture (no checker strip). */
export function patchSceneBundle(code: string, onStep?: PatchSceneBundleStepLog): string {
  let stepAt = performance.now()
  let out = patchCompositeSrcAlias(code)
  onStep?.('composite alias', performance.now() - stepAt)
  stepAt = performance.now()
  out = wrapAddTransportCalls(out, ADD_TRANSPORT_WRAP_LIMIT)
  onStep?.('addTransport capture', performance.now() - stepAt)
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

/** Suppress false warnings — any descendant MeshCollider/GltfContainer is a valid trigger setup. */
function descendantHasColliderSupport(
  entity: Entity,
  childrenByParent: Map<Entity, Entity[]>,
  MeshCollider: ReturnType<typeof components.MeshCollider>,
  GltfContainer: ReturnType<typeof generated.GltfContainer>
): boolean {
  const stack = [...(childrenByParent.get(entity) ?? [])]
  while (stack.length) {
    const current = stack.pop()!
    if (GltfContainer.has(current) || MeshCollider.has(current)) return true
    const children = childrenByParent.get(current)
    if (children?.length) stack.push(...children)
  }
  return false
}

/** True when `entity` itself has a pointer-blocking collider (SDK parity for same-entity check). */
function entityHasPointerCollider(
  entity: Entity,
  MeshCollider: ReturnType<typeof components.MeshCollider>,
  GltfContainer: ReturnType<typeof generated.GltfContainer>
): boolean {
  if (GltfContainer.has(entity)) return true
  if (MeshCollider.has(entity)) return true
  return false
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

  function threejsPointerEventColliderChecker(dt: number): void {
    timer += dt
    if (timer <= 10) return
    timer = 0

    const childrenByParent = buildChildrenByParent()

    for (const [entity] of engine.getEntitiesWith(PointerEvents)) {
      if (alreadyShown.has(entity)) continue
      if (UiTransform.has(entity)) continue
      if (entityHasPointerCollider(entity, MeshCollider, GltfContainer)) continue
      if (descendantHasColliderSupport(entity, childrenByParent, MeshCollider, GltfContainer)) continue

      alreadyShown.add(entity)
      console.log(
        `⚠️ Missing MeshCollider component on entity ${entity}. Add a MeshCollider to the entity so it can be clickeable by the player.
See https://docs.decentraland.org/creator/development-guide/sdk7/colliders/#pointer-blocking`
      )
    }
  }

  engine.addSystem(threejsPointerEventColliderChecker)
}
