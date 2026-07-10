import { readFileSync } from 'node:fs'
import { patchSceneBundle } from '../src/shim/worker/pointerEventColliderCheckerPatch.ts'
import {
  installEngineSystemLoopPartition,
  installSceneEngineUiScheduler,
  seedWorkerUiCanvasInformation
} from '../src/shim/worker/sceneEngineUiScheduler.ts'
import { evaluateSceneBundle } from '../src/shim/system/createSystemStubs.ts'
import { preregisterRendererInjectedComponents } from '../src/shim/worker/preregisterRendererInjectedComponents.ts'

async function boot(patched, useLoopPartition) {
  if (useLoopPartition) installEngineSystemLoopPartition()
  else delete globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__

  globalThis.__THREEJS_PREREGISTER_RENDERER_COMPONENTS__ = preregisterRendererInjectedComponents
  globalThis.__THREEJS_UI_VIRTUAL_CANVAS__ = (w, h) => {
    const eng = globalThis.__THREEJS_SCENE_ENGINE__
    if (eng) seedWorkerUiCanvasInformation(eng, w, h)
  }

  const requireMap = {
    '~system/EngineApi': {
      crdtSendToRenderer: async () => ({ data: [] }),
      crdtGetState: async () => ({ hasEntities: true, data: [] })
    },
    '~system/Runtime': {
      getSceneInformation: async () => ({}),
      getRealm: async () => ({ realmName: 'l', networkId: 1, isPreview: true }),
      getExplorerInformation: async () => ({}),
      getWorldTime: async () => ({ seconds: 0 })
    },
    '~system/RestrictedActions': {
      movePlayerTo: async () => ({ success: true }),
      triggerEmote: async () => ({ success: true }),
      triggerSceneEmote: async () => ({ success: true }),
      openExternalUrl: async () => ({ success: true })
    },
    '~system/Communications': {
      send: async () => ({}),
      sendBinary: async () => ({}),
      getUserData: async () => ({}),
      getRealm: async () => ({}),
      subscribeToTopic: async () => ({}),
      unsubscribeFromTopic: async () => ({}),
      publishData: async () => ({}),
      consumeMessages: async () => [],
      getActiveVideoStreams: async () => []
    },
    '~system/SignedFetch': {
      signedFetch: async () => ({ statusCode: 200, body: '', headers: {} }),
      getHeaders: async () => ({ headers: {} })
    }
  }

  const exports = evaluateSceneBundle(patched, requireMap)
  const eng = globalThis.__THREEJS_SCENE_ENGINE__
  installSceneEngineUiScheduler(eng)
  preregisterRendererInjectedComponents(eng)
  if (exports.onStart) await exports.onStart()
  if (exports.main) exports.main()
  try {
    await eng.update(0)
  } catch {
    /* transport stub */
  }

  let n = 0
  for (const c of eng.componentsIter()) {
    if (c.name === 'core::UiTransform') for (const _ of eng.getEntitiesWith(c)) n++
  }
  return n
}

const code = readFileSync('/tmp/planetangzaar-index.js', 'utf8')
const withLoop = patchSceneBundle(code)
const withoutLoop = code // raw bundle still has addTransport? need minimal patch
// Raw bundle won't capture engine — use withLoop stripped
const stripped = withLoop.replace(
  /globalThis\.__THREEJS_ENGINE_SYSTEM_LOOP__&&globalThis\.__THREEJS_ENGINE_SYSTEM_LOOP__\([^;]+\);/,
  (m) => {
    const eng = m.match(/\((\w+)\.getSystems/)?.[1] ?? 't'
    const dt = m.match(/getSystems\(\),(\w+),/)?.[1] ?? 'i'
    const check = m.includes('(0,') ? '(0,checkThenable)' : 'checkThenable'
    return `for(let __s of ${eng}.getSystems()){let __r=__s.fn(${dt});${check}(__r,\`A system (\${__s.name||"anonymous"}) returned a thenable.\`)}`
  }
)

const a = await boot(withLoop, true)
const b = await boot(stripped, false)
console.log(`WITH loop partition:    UiTransform=${a}`)
console.log(`WITHOUT loop partition: UiTransform=${b}`)
console.log(`stripped still has hook: ${stripped.includes('__THREEJS_ENGINE_SYSTEM_LOOP__')}`)