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

/** Minified bundles call `ae.addTransport(jP)` — capture the scene engine there (RickRoll, asset packs). */
const CAPTURE_ADD_TRANSPORT =
  `(function(__e,__t){if(__e&&typeof __e.update==="function"&&typeof __e.addSystem==="function"){${PREREGISTER_CALL}globalThis.__THREEJS_SCENE_ENGINE__=__e}return __e.addTransport(__t)})`

export function stripBundledPointerEventColliderChecker(code: string): string {
  const moduleCall =
    /\(\s*(?:0\s*,\s*)?([0-9a-zA-Z_$]+)\.pointerEventColliderChecker\s*\)\(\s*([0-9a-zA-Z_$]+(?:\.engine)?)\s*\)/g
  const directCall = /\bpointerEventColliderChecker\s*\(\s*([0-9a-zA-Z_$]+(?:\.engine)?)\s*\)/g
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

/** Capture sync-systems BinaryMessageBus (created in sync-systems `xq`) for proactive inbound feed. */
function patchBinaryMessageBusCapture(code: string): string {
  return code.replace(
    /p=ZG\(\(ye,le\)=>\{f\.push\(\{data:\[ye\],address:le\?\?\[\]\}\)\}\);/g,
    'p=ZG((ye,le)=>{f.push({data:[ye],address:le??[]})});globalThis.__THREEJS_BINARY_MESSAGE_BUS__=p;'
  )
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

/** Bundle transforms applied before `evaluateSceneBundle` — engine capture + checker strip. */
export function patchSceneBundle(code: string): string {
  // Network hook must run before CAPTURE_ADD_TRANSPORT — otherwise `e.addTransport(x)` is
  // wrapped in an IIFE and the `vq(M),e.addTransport(x)` pattern never matches (flagtag fort).
  let out = stripBundledPointerEventColliderChecker(code)
  out = patchNetworkTransportHook(out)
  out = patchCompositeSrcAlias(out)
  out = patchMainCompositeOnStartLoad(out)
  out = patchBinaryMessageBusCapture(out)
  out = out.replace(/(\w+)\.addTransport\((\w+)\)/g, `${CAPTURE_ADD_TRANSPORT}($1,$2)`)
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
