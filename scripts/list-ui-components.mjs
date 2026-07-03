import { readFileSync } from 'node:fs'
import { patchSceneBundle } from '../src/shim/worker/pointerEventColliderCheckerPatch.ts'
import { installReactEcsOnceGuard } from '../src/shim/worker/reactEcsOnce.ts'
import {
  installEngineSystemLoopPartition,
  installSceneEngineUiScheduler,
  seedWorkerUiCanvasInformation
} from '../src/shim/worker/sceneEngineUiScheduler.ts'
import { evaluateSceneBundle } from '../src/shim/system/createSystemStubs.ts'
import { preregisterRendererInjectedComponents } from '../src/shim/worker/preregisterRendererInjectedComponents.ts'

installReactEcsOnceGuard()
installEngineSystemLoopPartition()
const code = patchSceneBundle(readFileSync('/tmp/planetangzaar-index.js', 'utf8'))

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

const exports = evaluateSceneBundle(code, requireMap)
const eng = globalThis.__THREEJS_SCENE_ENGINE__
installSceneEngineUiScheduler(eng)
preregisterRendererInjectedComponents(eng)
try {
  if (exports.onStart) await exports.onStart()
} catch (e) {
  console.log('onStart err', e.message)
}
if (exports.main) exports.main()
try {
  await eng.update(0)
} catch (e) {
  console.log('update err', e.message)
}

const rows = []
for (const c of eng.componentsIter()) {
  let n = 0
  for (const _ of eng.getEntitiesWith(c)) n++
  if (n > 0) rows.push({ name: c.name, id: c.componentId, n })
}
rows.sort((a, b) => b.n - a.n)
console.log('top components:', rows.slice(0, 15))
console.log(
  'ui named:',
  rows.filter((r) => /ui/i.test(r.name))
)