/** Direct worker injection — bypasses CRDT round-trip when worker event loop is busy. */
export type InjectPointerClickBody = {
  /** PointerEvents entity (resolved target, not necessarily raycast mesh). */
  entity: number
  /** All entities that receive PointerEventsResult on PET_UP (ancestor chain). */
  entities: number[]
  /** PET_DOWN bubble targets — defaults to `entities` when omitted. */
  downEntities?: number[]
  /** PET_UP bubble targets — defaults to `entities` when omitted. */
  upEntities?: number[]
  /** Raycast hit entity id. */
  hitEntity: number
  button: number
  tickNumber: number
  downTimestamp: number
  upTimestamp: number
  hitPosition: { x: number; y: number; z: number }
  hitNormal: { x: number; y: number; z: number }
  hitDistance: number
  /** Ray origin in DCL space (Explorer RaycastHit.globalOrigin) — required for click VFX. */
  hitOrigin?: { x: number; y: number; z: number }
  /** Ray direction in DCL space (Explorer RaycastHit.direction). */
  hitDirection?: { x: number; y: number; z: number }
  meshName?: string
  /**
   * Scene DOM UI (react-ecs). Affects UP target resolution only:
   * PET_UP → PlayerEntity (clear isPressed without remount thrash).
   * World PE keeps UP on the hit entity (getClick / onPointerDown parity).
   */
  sceneUi?: boolean
  /**
   * Explorer press lifecycle for **all** scenes (see worker-input-architecture):
   * - `down` — PET_DOWN edge only; isPressed stays true across cooperative play frames
   * - `up` — PET_UP edge only; getClick / release handlers fire this frame
   * - `click` — deprecated combined batch; mapped to down+up only if a caller still sends it
   */
  phase?: 'down' | 'up' | 'click'
  /**
   * Live PrimaryPointerInfo for the edge tick — applied on the worker *before* eng.update(0).
   * Scenes gate select/move on PPI (UI chrome hit-test, ground ray from worldRayDirection).
   * Play-frame-tick alone is not enough: edge ticks can run without a play frame in between.
   */
  primaryPointer?: {
    pointerType: number
    screenCoordinates: { x: number; y: number }
    screenDelta: { x: number; y: number }
    worldRayDirection: { x: number; y: number; z: number }
  }
}
