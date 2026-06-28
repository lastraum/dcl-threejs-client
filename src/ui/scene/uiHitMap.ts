import type { Entity } from '@dcl/ecs'

export type UiScreenRegion = {
  entity: Entity
  left: number
  top: number
  width: number
  height: number
  zIndex: number
  /** UiTransform ancestry depth — deeper nodes win hit tests over overlapping parents. */
  depth: number
}

/** Screen-space hit regions for scene ECS UI (updated each layout pass). */
export class SceneUiHitMap {
  private regions: UiScreenRegion[] = []

  replace(regions: UiScreenRegion[]): void {
    this.regions = regions
  }

  clear(): void {
    this.regions = []
  }

  /** Regions containing (clientX, clientY), deepest / most specific first. */
  hitTestCandidates(clientX: number, clientY: number): Entity[] {
    if (!this.regions.length) return []
    const hits: UiScreenRegion[] = []
    for (const r of this.regions) {
      if (
        clientX >= r.left &&
        clientX <= r.left + r.width &&
        clientY >= r.top &&
        clientY <= r.top + r.height
      ) {
        hits.push(r)
      }
    }
    if (!hits.length) return []
    hits.sort((a, b) => {
      if (a.depth !== b.depth) return b.depth - a.depth
      if (a.zIndex !== b.zIndex) return b.zIndex - a.zIndex
      const areaA = a.width * a.height
      const areaB = b.width * b.height
      if (areaA !== areaB) return areaA - areaB
      return (a.entity as number) - (b.entity as number)
    })
    return hits.map((r) => r.entity)
  }

  /** Deepest visible region containing (clientX, clientY), or null. */
  hitTest(clientX: number, clientY: number): Entity | null {
    return this.hitTestCandidates(clientX, clientY)[0] ?? null
  }

  regionArea(entity: Entity): number | null {
    const r = this.regions.find((row) => row.entity === entity)
    return r ? r.width * r.height : null
  }

  regionFor(entity: Entity): Readonly<UiScreenRegion> | null {
    return this.regions.find((row) => row.entity === entity) ?? null
  }
}