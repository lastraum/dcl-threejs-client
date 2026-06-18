export enum RenderQualityTier {
  Low = 'low',
  Medium = 'medium',
  High = 'high'
}

export type RenderQualityOptions = {
  tier: RenderQualityTier
}

/** Max ECS LightSource lights active at once (nearest to view). */
export const LIGHT_LIMITS: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 4,
  [RenderQualityTier.Medium]: 6,
  [RenderQualityTier.High]: 10
}

export const MAX_SHADOW_SPOT_LIGHTS = 3
export const LIGHT_CULL_DISTANCE_M = 40

/** Spot shadow map resolution per tier (3 concurrent maps max — stays within WebGL texture units). */
export const SHADOW_MAP_SIZE: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 512,
  [RenderQualityTier.Medium]: 1024,
  [RenderQualityTier.High]: 1024
}

/** Renderer exposure with ACESFilmic tone mapping — tier-tuned; daytime sun needs slightly more headroom. */
export const TONE_MAPPING_EXPOSURE: Record<RenderQualityTier, number> = {
  [RenderQualityTier.Low]: 1.02,
  [RenderQualityTier.Medium]: 1.08,
  [RenderQualityTier.High]: 1.12
}

type Listener = (options: RenderQualityOptions) => void

const DEFAULT_OPTIONS: RenderQualityOptions = {
  tier: RenderQualityTier.Medium
}

/** Client render quality — drives LightManager culling limits (debug panel + runtime API). */
class RenderQualityStore {
  private options: RenderQualityOptions = { ...DEFAULT_OPTIONS }
  private readonly listeners = new Set<Listener>()

  getOptions(): RenderQualityOptions {
    return { ...this.options }
  }

  getTier(): RenderQualityTier {
    return this.options.tier
  }

  getMaxActiveLights(): number {
    return LIGHT_LIMITS[this.options.tier]
  }

  setOptions(partial: Partial<RenderQualityOptions>): void {
    const next = { ...this.options, ...partial }
    if (next.tier === this.options.tier) return
    this.options = next
    this.notify()
  }

  setTier(tier: RenderQualityTier): void {
    this.setOptions({ tier })
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    listener(this.getOptions())
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    const snapshot = this.getOptions()
    for (const listener of this.listeners) listener(snapshot)
  }
}

export const renderQuality = new RenderQualityStore()
