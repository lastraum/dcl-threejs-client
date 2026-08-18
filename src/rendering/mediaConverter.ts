/**
 * Explorer MediaConverter — same path Unity uses for remote scene textures.
 *
 * GetTextureWebRequest:
 *   https://metamorph-api.decentraland.org/convert?url={encoded}
 * 302 → metamorph-artifacts (KTX2, CORS *). Cached official HUD atlases live here
 * (light-atlas-v3.png is HTML on the website; converter still has the PNG as KTX2).
 */
import { toSceneHttpProxyUrl } from '../network/sceneHttpProxy'

export const MEDIA_CONVERTER_ORIGIN = 'https://metamorph-api.decentraland.org'

export function explorerMediaConverterUrl(sourceUrl: string): string {
  return `${MEDIA_CONVERTER_ORIGIN}/convert?url=${encodeURIComponent(sourceUrl)}`
}

/** Remote http(s) textures Explorer would send through MediaConverter (not localhost). */
export function shouldUseMediaConverter(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false
  try {
    const host = new URL(url).hostname.toLowerCase()
    if (host === 'localhost' || host === '127.0.0.1') return false
    if (host.includes('metamorph-api.decentraland.')) return false
    if (host.includes('metamorph-artifacts.decentraland.')) return false
    return true
  } catch {
    return false
  }
}

/** Same-origin fetch URL for the converter (follows 302 in the Vite/nginx proxy). */
export function proxiedMediaConverterUrl(sourceUrl: string): string {
  const convert = explorerMediaConverterUrl(sourceUrl)
  return toSceneHttpProxyUrl(convert) ?? convert
}
