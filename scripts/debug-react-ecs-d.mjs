import { readFileSync } from 'node:fs'
import { patchSceneBundle } from '../src/shim/worker/pointerEventColliderCheckerPatch.ts'
import {
  installEngineSystemLoopPartition,
  installSceneEngineUiScheduler,
  seedWorkerUiCanvasInformation
} from '../src/shim/worker/sceneEngineUiScheduler.ts'
import { evaluateSceneBundle } from '../src/shim/system/createSystemStubs.ts'
import { installReactEcsOnceGuard } from '../src/shim/worker/reactEcsOnce.ts'
import { preregisterRendererInjectedComponents } from '../src/shim/worker/preregisterRendererInjectedComponents.ts'

installReactEcsOnceGuard()
installEngineSystemLoopPartition()
let code = patchSceneBundle(readFileSync('/tmp/planetangzaar-index.js', 'utf8'))
let swId = 0
code = code.replace(
  'function sw(e,t){let r=ore(e,t),n,o,i=new Map',
  'function sw(e,t){let __swId=++globalThis.__SW_SEQ__;let r=ore(e,t),n,o,i=new Map'
)
globalThis.__SW_SEQ__ = 0
code = code.replace(
  /e\.addSystem\(d,1e5,"@dcl\/react-ecs"\)/g,
  '(console.log("[sw-add react-ecs] id="+__swId),e.addSystem(d,1e5,"@dcl/react-ecs"))'
)
code = code.replace(
  /setUiRenderer\(m,y\)\{try\{if\(y&&y\.virtualWidth>0&&y\.virtualHeight>0&&globalThis\.__THREEJS_UI_VIRTUAL_CANVAS__\)globalThis\.__THREEJS_UI_VIRTUAL_CANVAS__\(y\.virtualWidth,y\.virtualHeight\)\}catch\(__err\)\{\}console\.log\("\[setUiRenderer\] n=",!!m\);n=m,o=y\}/,
  'setUiRenderer(m,y){try{if(y&&y.virtualWidth>0&&y.virtualHeight>0&&globalThis.__THREEJS_UI_VIRTUAL_CANVAS__)globalThis.__THREEJS_UI_VIRTUAL_CANVAS__(y.virtualWidth,y.virtualHeight)}catch(__err){}console.log("[setUiRenderer] swId="+__swId+" n=",!!m);n=m,o=y}'
)
code = code.replace(
  'function d(){let m=[];try{console.log("[d] n=",!!n,"i.size=",i.size)}catch(_e){}',
  'function d(){let m=[];try{console.log("[d] swId="+__swId+" n=",!!n,"i.size=",i.size)}catch(_e){}'
)
code = code.replace(
  'm.length>0?r.update(VE.default.createElement(VE.default.Fragment,null,...m)):r.update(null)',
  'm.length>0?(console.log("[d] update fragment children",m.length),r.update(VE.default.createElement(VE.default.Fragment,null,...m))):(console.log("[d] update null n=",!!n),r.update(null))'
)

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
let reactEcsAdds = 0
const schedAdd = eng.addSystem.bind(eng)
eng.addSystem = (fn, priority, name) => {
  if (name === '@dcl/react-ecs') {
    reactEcsAdds++
    console.log(`[addSystem] @dcl/react-ecs #${reactEcsAdds} priority=${priority}`)
  }
  try {
    return schedAdd(fn, priority, name)
  } catch (e) {
    console.log(`[addSystem] rejected name=${name} — ${e.message}`)
    throw e
  }
}
if (exports.onStart) await exports.onStart()
if (exports.main) exports.main()
try {
  await eng.update(0)
} catch (e) {
  console.log('update fail', e.message)
}

let n = 0
for (const c of eng.componentsIter()) {
  if (c.name === 'core::UiTransform') for (const _ of eng.getEntitiesWith(c)) n++
}
console.log('UiTransform', n)