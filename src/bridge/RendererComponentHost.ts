import { Engine, type IEngine } from '@dcl/ecs'
import { NetworkEntity, NetworkParent } from '@dcl/ecs/dist/components'
import { registerMirrorComponents, type MirrorComponents } from './mirrorComponents'

/**
 * Binds @dcl/ecs component schemas (ids, serialize/deserialize) for the renderer.
 * No CRDT transports and no `engine.update()` — all runtime state lives in `CrdtProjection`.
 */
export class RendererComponentHost {
  readonly engine: IEngine
  readonly components: MirrorComponents
  readonly networkEntity: ReturnType<typeof NetworkEntity>
  readonly networkParent: ReturnType<typeof NetworkParent>

  constructor() {
    this.engine = Engine()
    this.components = registerMirrorComponents(this.engine)
    this.networkEntity = NetworkEntity(this.engine)
    this.networkParent = NetworkParent(this.engine)
    this.engine.seal()
  }
}
