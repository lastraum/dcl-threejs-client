import Hls from 'hls.js'

/**
 * Browser HLS for 2D landing / PIP / scene decode.
 *
 * `enableWorker` must stay **false**: Vite hashes the transmuxer worker URL and
 * production builds fail TS demux (same law as WebVideoPlayer / AudioStream).
 */
export function createBrowserHls(extra?: ConstructorParameters<typeof Hls>[0]): Hls {
  return new Hls({
    enableWorker: false,
    lowLatencyMode: false,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
    startLevel: -1,
    ...extra
  })
}

export function hlsFatalUserMessage(data: {
  type?: string
  details?: string
  response?: { code?: number }
}): string {
  const code = data.response?.code
  if (code === 404 || code === 410) {
    return 'This scene stream is offline right now.'
  }
  if (data.type === 'networkError' || data.details === 'manifestLoadError') {
    return 'Could not reach this stream (offline or blocked).'
  }
  return 'Could not play this stream (network or codec error).'
}

/** True when the URL is a real HLS playlist (not nginx 404 HTML). */
export async function probeHttpsHlsPlaylist(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, { method: 'GET', mode: 'cors', cache: 'no-store' })
    if (!res.ok) return false
    const text = await res.text()
    return text.includes('#EXTM3U')
  } catch {
    return false
  }
}
