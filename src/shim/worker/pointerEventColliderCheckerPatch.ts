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

/** Minified bundles call `ae.addTransport(jP)` — capture engine + hook transport (flagtag fort). */
const CAPTURE_ADD_TRANSPORT =
  `(function(__e,__t){if(__e&&typeof __e.update==="function"&&typeof __e.addSystem==="function"){${PREREGISTER_CALL}globalThis.__THREEJS_SCENE_ENGINE__=__e}globalThis.__THREEJS_HOOK_NETWORK_TRANSPORT__&&globalThis.__THREEJS_HOOK_NETWORK_TRANSPORT__(__t);return __e.addTransport(__t)})`

export function stripBundledPointerEventColliderChecker(code: string): string {
  const moduleCall =
    /\(\s*(?:0\s*,\s*)?([0-9a-zA-Z_$]+)\.pointerEventColliderChecker\s*\)\(\s*([0-9a-zA-Z_$]+(?:\.engine)?)\s*\)/g
  // Do not match `function pointerEventColliderChecker(engine)` definitions in bundled @dcl/ecs sources.
  const directCall =
    /(?<!function )pointerEventColliderChecker\s*\(\s*([0-9a-zA-Z_$]+(?:\.engine)?)\s*\)/g
  return code
    .replace(moduleCall, `${CAPTURE_ENGINE}($2);(void 0)`)
    .replace(directCall, `${CAPTURE_ENGINE}($1);(void 0)`)
}

/**
 * Some deploys inline composites as `assets/scene/main.composite` while onStart calls
 * `getCompositeOrNull("main.composite")` — alias lookup so composite instancing runs (opbadge).
 */
function patchCompositeSrcAlias(code: string): string {
  return code.replace(
    /getCompositeOrNull\((\w+)(?:,(\w+))?\)\{let (\w+)=(\w+)\[(\w+)\]/g,
    (_, arg0, arg1, varName, tableName, key) =>
      `getCompositeOrNull(${arg0}${arg1 ? `,${arg1}` : ''}){let ${varName}=${tableName}[${key}]||${tableName}["assets/scene/"+${key}]`
  )
}

/**
 * Capture @dcl/sdk BinaryMessageBus for inbound RES_CRDT_STATE dispatch.
 * Use literal markers only — broad minified regex on 13MB bundles (flagtag) can hang forever.
 */
function patchBinaryMessageBusCapture(code: string): string {
  const capture = 'globalThis.__THREEJS_BINARY_MESSAGE_BUS__'
  let out = code.replace(
    /p=ZG\(\(ye,le\)=>\{f\.push\(\{data:\[ye\],address:le\?\?\[\]\}\)\}\);/g,
    `p=ZG((ye,le)=>{f.push({data:[ye],address:le??[]})});${capture}=p;`
  )
  const busFactory =
    'function BinaryMessageBus(send2) {\n  const mapping = /* @__PURE__ */ new Map();\n  return {'
  const busCapture =
    'function BinaryMessageBus(send2) {\n  const mapping = /* @__PURE__ */ new Map();\n  const __threejsBus = {'
  if (out.includes(busFactory)) {
    out = out.replace(busFactory, busCapture)
    out = out.replace(
      '    }\n  };\n}\nfunction craftCommsMessage(messageType, payload)',
      `    }\n  };\n  ${capture}=__threejsBus;\n  return __threejsBus;\n}\nfunction craftCommsMessage(messageType, payload)`
    )
  }
  return out
}

/** Hook network transport so authoritative CRDT applied on the worker also forwards to main projection. */
function patchNetworkTransportHook(code: string): string {
  return code.replace(
    /vq\(M\),e\.addTransport\(x\)/g,
    'vq(M),e.addTransport(x),globalThis.__THREEJS_HOOK_NETWORK_TRANSPORT__&&globalThis.__THREEJS_HOOK_NETWORK_TRANSPORT__(x)'
  )
}

/**
 * Worlds like flagtag ship with an empty composite preload table (`oU={}`). onStart only
 * calls `getCompositeOrNull("main.composite")` — when that misses, the fort never instances
 * unless we fall through to `loadComposite` (readFile → assets/scene/main.composite).
 */
function patchMainCompositeOnStartLoad(code: string): string {
  return code.replace(
    /getCompositeOrNull\("main\.composite"\);if\((\w+)\)try\{(\w+)\.instance\((\w+),\1,(\w+)\)/g,
    'getCompositeOrNull("main.composite");if(!$1&&$4.loadComposite)$1=await $4.loadComposite("main.composite");if($1)try{$2.instance($3,$1,$4)'
  )
}

/** Wrap `engine.addTransport(x)` at call sites — bounded passes, not whole-file regex. */
function patchAddTransportCapture(code: string): string {
  const needle = '.addTransport('
  let out = code
  let from = 0
  let patched = 0
  while (patched < 8) {
    const at = out.indexOf(needle, from)
    if (at === -1) break
    let start = at
    while (start > 0 && /[0-9a-zA-Z_$]/.test(out[start - 1]!)) start--
    const open = at + needle.length
    let end = open
    while (end < out.length && /[0-9a-zA-Z_$]/.test(out[end]!)) end++
    if (end <= open) {
      from = at + needle.length
      continue
    }
    const recv = out.slice(start, at)
    const arg = out.slice(open, end)
    const original = `${recv}.addTransport(${arg})`
    const wrapped = `${CAPTURE_ADD_TRANSPORT}(${recv},${arg})`
    if (out.slice(start, end + 1) === original) {
      out = out.slice(0, start) + wrapped + out.slice(end + 1)
      from = start + wrapped.length
      patched++
      continue
    }
    from = at + needle.length
  }
  return out
}

/** Bundle transforms applied before `evaluateSceneBundle` — engine capture + checker strip. */
export function patchSceneBundle(code: string): string {
  let out = stripBundledPointerEventColliderChecker(code)
  out = patchNetworkTransportHook(out)
  out = patchCompositeSrcAlias(out)
  out = patchMainCompositeOnStartLoad(out)
  out = patchBinaryMessageBusCapture(out)
  out = patchAddTransportCapture(out)
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
