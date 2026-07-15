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
  meshName?: string
  /**
   * Scene DOM UI click (react-ecs). Worker uses this for inject-only UI path:
   * post-DOWN flush, skip onUpdate, PET_UP → PlayerEntity only.
   * Must not be set for 3D mesh clicks (getClick needs UP on the hit entity).
   */
  sceneUi?: boolean
}
