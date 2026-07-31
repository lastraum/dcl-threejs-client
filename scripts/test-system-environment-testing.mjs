/**
 * Smoke-check ~system/EnvironmentApi + ~system/Testing stubs without a full scene boot.
 * Run: npx tsx scripts/test-system-environment-testing.mjs
 */
import { createSystemStubs } from '../src/shim/system/createSystemStubs.ts'

const boot = {
  title: 'test',
  parcels: ['0,0'],
  baseParcel: '0,0',
  spawn: { x: 0, y: 0, z: 0 },
  contentsBaseUrl: 'https://peer.decentraland.org/',
  entityId: 'bafytestentity',
  mainEntry: 'bin/index.js',
  worldName: undefined,
  scriptUrl: '',
  content: [
    { file: 'bin/index.js', hash: 'QmHash1' },
    { file: 'scene.json', hash: 'QmHash2' }
  ],
  metadataJson: JSON.stringify({ display: { title: 'test' } })
}

const setCameraCalls = []
const rpc = {
  crdtSendToRenderer: async () => [],
  crdtGetState: async () => ({ hasEntities: false, data: [] }),
  movePlayerTo: async () => ({ success: true }),
  teleportTo: async () => ({}),
  changeRealm: async () => ({ success: true }),
  copyToClipboard: async () => ({}),
  triggerEmote: async () => ({ success: true }),
  triggerSceneEmote: async () => ({ success: true }),
  openExternalUrl: async () => ({ success: true }),
  openNftDialog: async () => ({ success: true }),
  setCameraTransform: async (body) => {
    setCameraCalls.push(body)
    return {}
  },
  commsSend: async () => ({}),
  comms: {
    setCommunicationsAdapter: async () => ({ success: true }),
    send: async () => ({}),
    sendBinary: async () => ({ data: [] }),
    getUserData: async () => ({ data: undefined }),
    getRealm: async () => ({
      realmInfo: {
        baseUrl: 'https://peer.decentraland.org',
        realmName: 'main',
        networkId: 1,
        commsAdapter: 'livekit:wss://example',
        isPreview: false,
        room: 'island-1',
        isConnectedSceneRoom: true
      }
    }),
    subscribeToTopic: async () => ({}),
    unsubscribeFromTopic: async () => ({}),
    publishData: async () => ({}),
    consumeMessages: async () => ({ messages: [] }),
    getActiveVideoStreams: async () => ({ streams: [] })
  },
  signedFetch: async () => ({ ok: true, status: 200, statusText: 'OK', headers: {}, body: '' }),
  signedFetchGetHeaders: async () => ({ headers: {} })
}

const engineApiEvents = {
  drainEvents: () => [],
  subscribe: () => {},
  unsubscribe: () => {}
}

const { requireMap } = createSystemStubs(boot, rpc, engineApiEvents)
const env = requireMap['~system/EnvironmentApi']
const testing = requireMap['~system/Testing']

function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const bootstrap = await env.getBootstrapData({})
assert(bootstrap.id === 'bafytestentity', 'bootstrap id')
assert(bootstrap.baseUrl.includes('content/contents'), 'bootstrap baseUrl')
assert(bootstrap.entity.content.length === 2, 'bootstrap content')
assert(bootstrap.useFPSThrottling === false, 'fps throttle')

const preview = await env.isPreviewMode({})
assert(preview.isPreview === false, 'preview from realm')

const platform = await env.getPlatform({})
assert(platform.platform === 'web', 'platform')

const unsafe = await env.areUnsafeRequestAllowed({})
assert(unsafe.status === true, 'unsafe allowed')

const realm = await env.getCurrentRealm({})
assert(realm.currentRealm?.serverName === 'main', 'realm serverName')
assert(realm.currentRealm?.room === 'island-1', 'realm room')
assert(realm.currentRealm?.protocol === 'v3', 'realm protocol')

const explorer = await env.getExplorerConfiguration({})
assert(typeof explorer.clientUri === 'string', 'clientUri')
assert(explorer.configurations.agent === 'Decentraland/ThreejsClient', 'agent')

const time = await env.getDecentralandTime({})
assert(typeof time.seconds === 'number' && time.seconds > 0, 'time seconds')

await testing.plan({ tests: [{ name: 'a' }, { name: 'b' }] })
await testing.logTestResult({
  name: 'a',
  ok: true,
  totalFrames: 2,
  totalTime: 0.05
})
await testing.setCameraTransform({
  position: { x: 1, y: 2, z: 3 },
  rotation: { x: 0, y: 0, z: 0, w: 1 }
})
assert(setCameraCalls.length === 1, 'setCameraTransform rpc')
assert(setCameraCalls[0].position.y === 2, 'camera y')

const shot = await testing.takeAndCompareScreenshot({})
assert(shot.storedSnapshotFound === false, 'screenshot stub')

console.log('✅ ~system/EnvironmentApi + ~system/Testing smoke passed')
