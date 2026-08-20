import {
  renderQuality,
  SHADOW_QUALITY_LADDER,
  type ShadowQuality
} from './RenderQualitySettings'

/**
 * Runtime FPS → temporary bloom / shadow quality / resolution scale.
 *
 * - Never writes Preferences / localStorage for step-down values.
 * - Never raises quality above the user's ceiling (slider / preset).
 * - Step-down: **shadows → bloom → resolution**.
 * - Step-up: **resolution → bloom → shadows**.
 */
export class AdaptiveQualityController {
  /** Need this many consecutive low windows before stepping down. */
  private static readonly BAD_WINDOWS = 3
  /** Need this many consecutive healthy windows before stepping up. */
  private static readonly GOOD_WINDOWS = 4
  private static readonly LOW_FPS = 28
  private static readonly HIGH_FPS = 45
  /** Min ms between any step (down or up). */
  private static readonly COOLDOWN_MS = 1600
  private static readonly RES_STEP = 12
  /** CBD can sit at 8–15 FPS with full mesh inventory — allow more internal res drop. */
  private static readonly RES_FLOOR = 40
  /** Below this, step resolution even if shadows already at floor. */
  private static readonly CRITICAL_FPS = 14

  private windowFrames = 0
  private windowStart = 0
  private badStreak = 0
  private goodStreak = 0
  private lastStepAt = 0
  /** 0 = at user ceiling; positive = steps below. */
  private resStepsDown = 0
  private shadowStepsDown = 0
  /** 0 = user bloom; 1 = adaptive forced bloom off (only if user has bloom on). */
  private bloomStepsDown = 0
  private unsub: (() => void) | null = null
  private lastCeilingRes = -1
  private lastCeilingShadow: ShadowQuality | '' = ''
  private lastCeilingBloom = false

  start(): void {
    if (this.unsub) return
    this.lastCeilingRes = renderQuality.getUserResolutionScale()
    this.lastCeilingShadow = renderQuality.getUserShadowQuality()
    this.lastCeilingBloom = renderQuality.getUserBloomEnabled()
    // Re-clamp when user moves Preferences ceiling; ignore adaptive-only notifies.
    this.unsub = renderQuality.subscribe(() => {
      if (!renderQuality.getAdaptiveQualityEnabled()) {
        this.resStepsDown = 0
        this.shadowStepsDown = 0
        this.bloomStepsDown = 0
        this.lastCeilingRes = renderQuality.getUserResolutionScale()
        this.lastCeilingShadow = renderQuality.getUserShadowQuality()
        this.lastCeilingBloom = renderQuality.getUserBloomEnabled()
        return
      }
      const ceilingRes = renderQuality.getUserResolutionScale()
      const ceilingShadow = renderQuality.getUserShadowQuality()
      const ceilingBloom = renderQuality.getUserBloomEnabled()
      if (
        ceilingRes !== this.lastCeilingRes ||
        ceilingShadow !== this.lastCeilingShadow ||
        ceilingBloom !== this.lastCeilingBloom
      ) {
        this.lastCeilingRes = ceilingRes
        this.lastCeilingShadow = ceilingShadow
        this.lastCeilingBloom = ceilingBloom
        // User raised/lowered settings — reset temporary steps so prefs win.
        this.resStepsDown = 0
        this.shadowStepsDown = 0
        this.bloomStepsDown = 0
        renderQuality.clearAdaptiveOverrides()
      }
    })
  }

  stop(): void {
    this.unsub?.()
    this.unsub = null
    this.resStepsDown = 0
    this.shadowStepsDown = 0
    this.bloomStepsDown = 0
    renderQuality.clearAdaptiveOverrides()
  }

  /**
   * Call once per completed rendered frame (not when rAF is interval-skipped).
   */
  noteFrame(): void {
    if (!renderQuality.getAdaptiveQualityEnabled()) {
      if (renderQuality.isAdaptiveReducing()) {
        this.resStepsDown = 0
        this.shadowStepsDown = 0
        this.bloomStepsDown = 0
        renderQuality.clearAdaptiveOverrides()
      }
      return
    }

    const now = performance.now()
    if (this.windowStart <= 0) {
      this.windowStart = now
      this.windowFrames = 1
      return
    }
    this.windowFrames++
    const elapsed = now - this.windowStart
    if (elapsed < 1000) return

    const fps = (this.windowFrames * 1000) / elapsed
    this.windowStart = now
    this.windowFrames = 0
    this.onFpsSample(fps, now)
  }

  private onFpsSample(fps: number, now: number): void {
    if (fps < AdaptiveQualityController.LOW_FPS) {
      this.badStreak++
      this.goodStreak = 0
      const critical = fps < AdaptiveQualityController.CRITICAL_FPS
      const cooldown = critical
        ? AdaptiveQualityController.COOLDOWN_MS * 0.5
        : AdaptiveQualityController.COOLDOWN_MS
      if (
        this.badStreak >= AdaptiveQualityController.BAD_WINDOWS &&
        now - this.lastStepAt >= cooldown
      ) {
        // Critical: try up to 2 steps in one window so CBD recovers.
        let stepped = this.stepDown()
        if (critical && stepped) stepped = this.stepDown() || stepped
        if (stepped) {
          this.lastStepAt = now
          this.badStreak = 0
          console.info(
            `[adaptive-quality] step-down fps=${fps.toFixed(0)} ` +
              `bloomOff=${this.bloomStepsDown > 0} resSteps=${this.resStepsDown} ` +
              `shadowSteps=${this.shadowStepsDown}`
          )
        }
      }
      return
    }

    if (fps >= AdaptiveQualityController.HIGH_FPS) {
      this.goodStreak++
      this.badStreak = 0
      if (
        this.goodStreak >= AdaptiveQualityController.GOOD_WINDOWS &&
        now - this.lastStepAt >= AdaptiveQualityController.COOLDOWN_MS &&
        (this.resStepsDown > 0 || this.shadowStepsDown > 0 || this.bloomStepsDown > 0)
      ) {
        if (this.stepUp()) {
          this.lastStepAt = now
          this.goodStreak = 0
        }
      }
      return
    }

    // Mid band — hold; reset streaks slowly so we don't thrash.
    this.badStreak = 0
    this.goodStreak = 0
  }

  private stepDown(): boolean {
    // 1) Shadows first — big GPU multiplier; softer/no shadows before killing bloom/res.
    const ceilingShadow = renderQuality.getUserShadowQuality()
    const ceilingIdx = SHADOW_QUALITY_LADDER.indexOf(ceilingShadow)
    if (ceilingIdx > 0 && this.shadowStepsDown < ceilingIdx) {
      this.shadowStepsDown++
      this.applyFromSteps()
      return true
    }

    // 2) Bloom off (only if user has bloom on).
    if (renderQuality.getUserBloomEnabled() && this.bloomStepsDown < 1) {
      this.bloomStepsDown = 1
      this.applyFromSteps()
      return true
    }

    // 3) Resolution last — most noticeable.
    const ceilingRes = renderQuality.getUserResolutionScale()
    const minRes = Math.min(ceilingRes, AdaptiveQualityController.RES_FLOOR)
    const maxResSteps = Math.max(
      0,
      Math.floor((ceilingRes - minRes) / AdaptiveQualityController.RES_STEP)
    )
    if (this.resStepsDown < maxResSteps) {
      this.resStepsDown++
      this.applyFromSteps()
      return true
    }

    return false
  }

  private stepUp(): boolean {
    // Restore cheapest-to-notice first: resolution → bloom → shadows.
    if (this.resStepsDown > 0) {
      this.resStepsDown--
      this.applyFromSteps()
      return true
    }
    if (this.bloomStepsDown > 0) {
      this.bloomStepsDown = 0
      this.applyFromSteps()
      return true
    }
    if (this.shadowStepsDown > 0) {
      this.shadowStepsDown--
      this.applyFromSteps()
      return true
    }
    return false
  }

  private applyFromSteps(): void {
    if (!renderQuality.getAdaptiveQualityEnabled()) {
      renderQuality.clearAdaptiveOverrides()
      return
    }

    const ceilingRes = renderQuality.getUserResolutionScale()
    const minRes = Math.min(ceilingRes, AdaptiveQualityController.RES_FLOOR)
    const maxResSteps = Math.max(
      0,
      Math.floor((ceilingRes - minRes) / AdaptiveQualityController.RES_STEP)
    )
    this.resStepsDown = Math.min(this.resStepsDown, maxResSteps)

    const ceilingShadow = renderQuality.getUserShadowQuality()
    const ceilingIdx = Math.max(0, SHADOW_QUALITY_LADDER.indexOf(ceilingShadow))
    this.shadowStepsDown = Math.min(this.shadowStepsDown, ceilingIdx)

    if (!renderQuality.getUserBloomEnabled()) {
      this.bloomStepsDown = 0
    }

    const nextRes =
      this.resStepsDown <= 0
        ? null
        : Math.max(minRes, ceilingRes - this.resStepsDown * AdaptiveQualityController.RES_STEP)

    let nextShadow: ShadowQuality | null = null
    if (this.shadowStepsDown > 0) {
      const idx = Math.max(0, ceilingIdx - this.shadowStepsDown)
      nextShadow = SHADOW_QUALITY_LADDER[idx] ?? 'off'
      if (nextShadow === ceilingShadow) nextShadow = null
    }

    renderQuality.setAdaptiveOverrides({
      resolutionScale: nextRes,
      shadowQuality: nextShadow,
      bloomOff: this.bloomStepsDown > 0
    })
  }
}
