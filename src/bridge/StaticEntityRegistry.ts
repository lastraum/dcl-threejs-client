import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from './mirrorComponents'
import type { ProjectionView } from './ProjectionView'

/** Scene props that stop receiving renderer Transform diff after play-ready until thawed. */
export class StaticEntityRegistry {
  private enabled = false
  private readonly frozen = new Set<Entity>()

  setEnabled(enabled: boolean): void {
    this.enabled = enabled
    if (!enabled) this.frozen.clear()
  }

  isEnabled(): boolean {
    return this.enabled
  }

  isFrozen(entity: Entity): boolean {
    return this.enabled && this.frozen.has(entity)
  }

  thaw(entity: Entity): boolean {
    return this.frozen.delete(entity)
  }

  thawAll(): void {
    this.frozen.clear()
  }

  /** Components that imply the entity must stay dynamically synced. */
  isDynamic(entity: Entity, components: MirrorComponents, view: ProjectionView): boolean {
    if (
      entity === view.RootEntity ||
      entity === view.PlayerEntity ||
      entity === view.CameraEntity
    ) {
      return true
    }
    const { Animator, Tween, TweenState, AvatarShape, PointerEvents, MeshCollider } = components
    if (Animator.has(entity) || Tween.has(entity) || TweenState.has(entity) || AvatarShape.has(entity)) {
      return true
    }
    if (PointerEvents.has(entity) || MeshCollider.has(entity)) return true
    return false
  }

  canFreeze(entity: Entity, components: MirrorComponents, view: ProjectionView): boolean {
    const { Transform, GltfContainer, MeshRenderer } = components
    if (!Transform.has(entity)) return false
    if (this.isDynamic(entity, components, view)) return false
    return GltfContainer.has(entity) || MeshRenderer.has(entity)
  }

  /** Scan projection after hydration — freeze decorative props that never animate. */
  freezeEligible(view: ProjectionView, components: MirrorComponents): number {
    this.frozen.clear()
    const { Transform } = components
    let count = 0
    for (const [entity] of view.getEntitiesWith(Transform)) {
      if (!this.canFreeze(entity, components, view)) continue
      this.frozen.add(entity)
      count++
    }
    return count
  }

  shouldThawOnComponentPut(
    entity: Entity,
    componentId: number,
    components: MirrorComponents
  ): boolean {
    if (!this.isFrozen(entity)) return false
    const thawIds = new Set<number>([
      components.Animator.componentId,
      components.Tween.componentId,
      components.TweenState.componentId,
      components.AvatarShape.componentId,
      components.PointerEvents.componentId,
      components.MeshCollider.componentId
    ])
    return thawIds.has(componentId)
  }

  forEachFrozen(fn: (entity: Entity) => void): void {
    for (const entity of this.frozen) fn(entity)
  }
}