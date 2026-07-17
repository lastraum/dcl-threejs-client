import type { Entity } from '@dcl/ecs'
import type { PBMapPin } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/map_pin.gen'
import type { ProjectionView } from '../bridge/ProjectionView'
import type { MirrorComponents } from '../bridge/mirrorComponents'

export type MapPinEntry = {
  entity: Entity
  /** Genesis-style map coords (PB Vector2 — typically parcel X/Y). */
  x: number
  y: number
  title: string
  description: string
  iconSize: number
}

/**
 * Scene MapPin (1097) registry — mirror CRDT + queryable list for map/minimap layers.
 * Component is marked deprecated upstream (orchestrator PX); we still honor scene data.
 */
export class MapPinStore {
  private pins: MapPinEntry[] = []
  private dirty = true
  private ecs: MirrorComponents | null = null
  private view: ProjectionView | null = null

  bind(ecs: MirrorComponents, view: ProjectionView): void {
    this.ecs = ecs
    this.view = view
    this.dirty = true
  }

  dispose(): void {
    this.ecs = null
    this.view = null
    this.pins = []
    this.dirty = true
  }

  invalidate(): void {
    this.dirty = true
  }

  /** Rebuild from projection when dirty; return current pin list. */
  list(): readonly MapPinEntry[] {
    this.rebuildIfNeeded()
    return this.pins
  }

  private rebuildIfNeeded(): void {
    if (!this.dirty || !this.ecs || !this.view) return
    this.dirty = false
    this.pins = []
    const { MapPin } = this.ecs
    const view = this.view
    for (const [entity, raw] of view.getEntitiesWith(MapPin)) {
      if (
        entity === view.RootEntity ||
        entity === view.PlayerEntity ||
        entity === view.CameraEntity
      ) {
        continue
      }
      const pin = raw as PBMapPin
      const pos = pin.position
      if (!pos || !Number.isFinite(pos.x) || !Number.isFinite(pos.y)) continue
      this.pins.push({
        entity,
        x: pos.x,
        y: pos.y,
        title: typeof pin.title === 'string' ? pin.title : '',
        description: typeof pin.description === 'string' ? pin.description : '',
        iconSize: Number.isFinite(pin.iconSize) ? pin.iconSize : 1
      })
    }
  }
}
