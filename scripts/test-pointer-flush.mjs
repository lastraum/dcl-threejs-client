import { Engine } from '@dcl/ecs'
import * as generated from '@dcl/ecs/dist/components/generated/index.gen.js'

const engine = Engine()
const PointerEventsResult = generated.PointerEventsResult(engine)
const Transform = generated.Transform(engine)
engine.seal()

const sceneTransport = {
  type: 'scene',
  filter: () => true,
  send: async (message) => {
    const chunks = message instanceof Uint8Array ? [message] : message
    for (const chunk of chunks) pending.push(chunk)
  }
}
const rendererTransport = { type: 'renderer', filter: () => true, send: async () => {} }
engine.addTransport(sceneTransport)
engine.addTransport(rendererTransport)

const pending = []
const e = engine.addEntity()
Transform.create(e, {
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0, w: 1 },
  scale: { x: 1, y: 1, z: 1 },
  parent: engine.RootEntity
})

PointerEventsResult.addValue(e, {
  button: 0,
  state: 1,
  timestamp: 1,
  tickNumber: 1,
  hit: {
    position: { x: 0, y: 0, z: 0 },
    globalOrigin: { x: 0, y: 0, z: 0 },
    direction: { x: 0, y: 0, z: 1 },
    length: 1,
    meshName: '',
    entityId: e
  }
})

pending.length = 0
await engine.update(0)
console.log('pending after update:', pending.length, pending.map((p) => p.byteLength))
