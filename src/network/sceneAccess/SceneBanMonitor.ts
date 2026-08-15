import type { LoginResult } from '../../auth/AuthClient'
import type { ResolvedScene } from '../../dcl/content/types'
import { probeSceneAccess } from './probeSceneAccess'
import type { SceneAccessDeniedError } from './SceneAccessDeniedError'

/** Player ban detection — polls `get-scene-adapter` (no client webhook exists). */
export const SCENE_BAN_POLL_MS = 10_000

export type SceneBanMonitorOptions = {
  intervalMs?: number
  getScene: () => ResolvedScene | null
  getLogin: () => LoginResult | null
  isEnabled: () => boolean
  onBanned: (err: SceneAccessDeniedError) => void | Promise<void>
}

/** Polls gatekeeper + metadata blacklist while the user is in a scene. */
export class SceneBanMonitor {
  private readonly intervalMs: number
  private readonly getScene: SceneBanMonitorOptions['getScene']
  private readonly getLogin: SceneBanMonitorOptions['getLogin']
  private readonly isEnabled: SceneBanMonitorOptions['isEnabled']
  private readonly onBanned: SceneBanMonitorOptions['onBanned']
  private timer: ReturnType<typeof setInterval> | null = null
  private probing = false
  private handlingBan = false

  constructor(opts: SceneBanMonitorOptions) {
    this.intervalMs = opts.intervalMs ?? SCENE_BAN_POLL_MS
    this.getScene = opts.getScene
    this.getLogin = opts.getLogin
    this.isEnabled = opts.isEnabled
    this.onBanned = opts.onBanned
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => void this.tick(), this.intervalMs)
    void this.tick()
  }

  stop(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private async tick(): Promise<void> {
    if (this.probing || this.handlingBan || !this.isEnabled()) return

    const scene = this.getScene()
    const login = this.getLogin()
    if (!scene || scene.source.kind === 'blank' || scene.source.kind === 'preview') return
    if (!login || login.kind !== 'wallet') return

    this.probing = true
    try {
      const denied = await probeSceneAccess(scene, login)
      if (!denied || !this.isEnabled()) return
      this.handlingBan = true
      try {
        await this.onBanned(denied)
      } finally {
        this.handlingBan = false
      }
    } finally {
      this.probing = false
    }
  }
}