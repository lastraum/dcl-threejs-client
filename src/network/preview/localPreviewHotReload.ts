import type { ResolvedScene } from '../../dcl/content/types'
import {
  isLocalPreviewScene,
  previewOriginFromScene,
  refreshPreviewRealmScene
} from '../../dcl/content/refreshPreviewScene'
import {
  parsePreviewWsBinary,
  parsePreviewWsText,
  previewWsUrlFromHttp,
  type PreviewSceneUpdate
} from './wsSceneMessage'

const RETRY_MS = 5_000

export type LocalPreviewReloadHandler = (update: PreviewSceneUpdate) => void | Promise<void>

/**
 * Unity `LocalSceneDevelopmentController`: stay connected to the Creator Hub /
 * sdk-commands preview websocket and fire on SCENE_UPDATE / UpdateModel.
 */
export class LocalPreviewHotReload {
  private socket: WebSocket | null = null
  private stopped = false
  private retryTimer: number | null = null
  private readonly origin: string
  private readonly onUpdate: LocalPreviewReloadHandler

  constructor(origin: string, onUpdate: LocalPreviewReloadHandler) {
    this.origin = origin.replace(/\/+$/, '')
    this.onUpdate = onUpdate
  }

  start(): void {
    this.stopped = false
    this.connect()
  }

  stop(): void {
    this.stopped = true
    if (this.retryTimer != null) {
      window.clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    try {
      this.socket?.close()
    } catch {
      /* ignore */
    }
    this.socket = null
  }

  private connect(): void {
    if (this.stopped) return
    const url = previewWsUrlFromHttp(this.origin)
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch (err) {
      console.warn('[preview] websocket construct failed', url, err)
      this.scheduleRetry()
      return
    }
    this.socket = ws
    ws.binaryType = 'arraybuffer'
    ws.onopen = () => {
      console.info('[preview] connected', url)
    }
    ws.onmessage = (ev) => {
      void (async () => {
        const update = await decodePreviewEvent(ev.data)
        if (!update) return
        await this.onUpdate(update)
      })()
    }
    ws.onerror = () => {
      /* onclose retries */
    }
    ws.onclose = () => {
      if (this.socket === ws) this.socket = null
      if (!this.stopped) this.scheduleRetry()
    }
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer != null) return
    this.retryTimer = window.setTimeout(() => {
      this.retryTimer = null
      this.connect()
    }, RETRY_MS)
  }
}

export function localPreviewOriginForScene(scene: ResolvedScene): string | null {
  if (!isLocalPreviewScene(scene)) return null
  return previewOriginFromScene(scene)
}

export { refreshPreviewRealmScene, isLocalPreviewScene }

async function decodePreviewEvent(data: unknown): Promise<PreviewSceneUpdate | null> {
  if (typeof data === 'string') return parsePreviewWsText(data)
  if (data instanceof ArrayBuffer) return parsePreviewWsBinary(new Uint8Array(data))
  if (data instanceof Uint8Array) return parsePreviewWsBinary(data)
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    const buf = await data.arrayBuffer()
    return parsePreviewWsBinary(new Uint8Array(buf))
  }
  return null
}
