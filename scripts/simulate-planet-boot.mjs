import { readFileSync } from 'node:fs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen.js'
import { patchSceneBundle } from '../src/shim/worker/pointerEventColliderCheckerPatch.ts'
import {
  installEngineSystemLoopPartition,
  installSceneEngineUiScheduler,
  seedWorkerUiCanvasInformation
} from '../src/shim/worker/sceneEngineUiScheduler.ts'
import { evaluateSceneBundle } from '../src/shim/system/createSystemStubs.ts'
import { installReactEcsOnceGuard } from '../src/shim/worker/reactEcsOnce.ts'
import { preregisterRendererInjectedComponents } from '../src/shim/worker/preregisterRendererInjectedComponents.ts'

const code = readFileSync('/tmp/planetangzaar-index.js', 'utf8')
installReactEcsOnceGuard()
installEngineSystemLoopPartition()
const patched = patchSceneBundle(code)

const outbound = []
const requireMap = {
  '~system/Runtime': {
    getSceneInformation: async () => ({ urn: '', content: [], metadataJson: '{}', baseUrl: 'http://x/' }),
    getRealm: async () => ({
      baseUrl: 'http://x',
      realmName: 'local',
      networkId: 1,
      commsAdapter: '',
      isPreview: true,
      isConnectedSceneRoom: false
    }),
    getExplorerInformation: async () => ({ agent: 'test', platform: 'web', configurations: {} }),
    getUserData: async () => ({}),
    getWorldTime: async () => ({ seconds: 0 }),
    getCameraMode: async () => ({ mode: 1 }),
    getPointerState: async () => ({}),
    getServerInfo: async () => ({})
  },
  '~system/EngineApi': {
    crdtSendToRenderer: async ({ data }) => {
      outbound.push(data?.byteLength ?? 0)
      return { data: [] }
    },
    crdtGetState: async () => ({ hasEntities: true, data: [] })
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
  '~system/RestrictedActions': {
    movePlayerTo: async () => ({ success: true }),
    triggerEmote: async () => ({ success: true }),
    triggerSceneEmote: async () => ({ success: true }),
    openExternalUrl: async () => ({ success: true })
  },
  '~system/SignedFetch': {
    signedFetch: async () => ({ statusCode: 200, body: '', headers: {} }),
    getHeaders: async () => ({ headers: {} })
  }
}

globalThis.__THREEJS_PREREGISTER_RENDERER_COMPONENTS__ = preregisterRendererInjectedComponents
let virtualCanvas = null
globalThis.__THREEJS_UI_VIRTUAL_CANVAS__ = (w, h) => {
  virtualCanvas = { w, h }
  const eng = globalThis.__THREEJS_SCENE_ENGINE__
  if (eng) seedWorkerUiCanvasInformation(eng, w, h)
}

const exports = evaluateSceneBundle(patched, requireMap)
const eng = globalThis.__THREEJS_SCENE_ENGINE__
installSceneEngineUiScheduler(eng)
preregisterRendererInjectedComponents(eng)

function countUi(label) {
  let viaBundle = 0
  let viaGen = 0
  for (const c of eng.componentsIter()) {
    if (c.componentId === 1050) {
      for (const _ of eng.getEntitiesWith(c)) viaBundle++
    }
  }
  try {
    const gen = generated.UiTransform(eng)
    for (const _ of eng.getEntitiesWith(gen)) viaGen++
  } catch {
    /* ignore */
  }
  console.log(`${label} — UiTransform id1050: ${viaBundle}, generated getter: ${viaGen}`)
}

function listReactSystems() {
  const systems = []
  for (const s of eng.getSystems?.() ?? []) {
    if (s.name?.includes('react-ecs')) systems.push(s.name)
  }
  console.log('react-ecs systems:', systems.join(', ') || '(none)')
}

listReactSystems()

// Mirror worker boot: onStart → optional main → engine.update(0)
console.log('--- onStart ---')
if (exports.onStart) await exports.onStart()
countUi('after onStart')

console.log('--- main (worker invokeSceneMainBootstrap) ---')
if (typeof exports.main === 'function') {
  const r = exports.main()
  if (typeof r === 'function') r()
  if (r && typeof r.then === 'function') await r
}
countUi('after main')
console.log('virtualCanvas', virtualCanvas)

const origPartition = globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__
globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__ = (systems, dt, runOne) => {
  let reactRan = false
  const names = []
  origPartition(systems, dt, (sys, d) => {
    if (sys.name) names.push(sys.name)
    if (sys.name === '@dcl/react-ecs') {
      reactRan = true
      console.log('[partition] react-ecs reconcile tick')
    }
    runOne(sys, d)
  })
  console.log(`[partition] systems=${systems.length} reactRan=${reactRan} names=${names.filter((n) => n.includes('react')).join(',') || '—'}`)
}

console.log('--- engine.update(0) ---')
try {
  await eng.update(0)
  console.log('update ok, outbound bytes', outbound)
} catch (e) {
  console.log('update err', e?.message ?? e)
  console.log(e?.stack?.split('\n').slice(0, 8).join('\n'))
}
countUi('after update(0)')

console.log('--- engine.update(0) x2 (splash timer) ---')
try {
  await eng.update(0.016)
  await eng.update(0.016)
} catch (e) {
  console.log('update2 err', e?.message ?? e)
}
countUi('after update x3')