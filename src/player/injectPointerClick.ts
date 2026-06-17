/** Direct worker injection — bypasses CRDT round-trip when worker event loop is busy. */
export type InjectPointerClickBody = {
  /** PointerEvents entity (resolved target, not necessarily raycast mesh). */
  entity: number
  /** All entities that receive PointerEventsResult (ancestor chain). */
  entities: number[]
  /** Raycast hit entity id. */
  hitEntity: number
  button: number
  tickNumber: number
  downTimestamp: number
  upTimestamp: number
  hitPosition: { x: number; y: number; z: number }
  hitNormal: { x: number; y: number; z: number }
  hitDistance: number
  meshName?: string
}
