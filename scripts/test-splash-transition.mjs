import { readFileSync } from 'node:fs'
import { patchSceneBundle } from '../src/shim/worker/pointerEventColliderCheckerPatch.ts'
import { installReactEcsOnceGuard } from '../src/shim/worker/reactEcsOnce.ts'
import {
  computeWorkerUiFingerprint,
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
} catch {
  /* profile fetch */
}
if (exports.main) exports.main()

const fp0 = computeWorkerUiFingerprint(eng)
for (let i = 0; i < 60; i++) {
  try {
    await eng.update(1)
  } catch {
    /* stub transport */
  }
}
const fp1 = computeWorkerUiFingerprint(eng)
console.log('fingerprint boot', fp0.length, 'after 60s sim ticks', fp1.length, 'changed', fp0 !== fp1)