/**
 * Open the official Decentraland mobile app at the current place.
 *
 * Native scheme (Explorer + Godot mobile):
 *   Worlds:  decentraland://?realm=NAME.dcl.eth
 *   Parcels: decentraland://?position=x,y
 *
 * https://decentraland.org/jump/ is a download interstitial on phones and
 * does not hand off to the app — do not send mobile users there.
 */
import QRCode from 'qrcode'
import type { SceneLandingRoute } from '../../../dcl/content/route'
import { isOfficialWorldsServer } from '../../../network/worlds/worldsServerConfig'

export const DCL_ANDROID_PACKAGE = 'org.decentraland.godotexplorer'
export const DCL_ANDROID_STORE =
  'https://play.google.com/store/apps/details?id=org.decentraland.godotexplorer'
export const DCL_IOS_STORE = 'https://apps.apple.com/app/decentraland/id6478403840'

const STORE_FALLBACK_MS = 1200

/** Official Worlds / Genesis parcels — not local preview or a custom worlds host. */
export function canOpenDclMobileApp(route: SceneLandingRoute): boolean {
  if (route.kind === 'coords') return true
  if (route.kind === 'world') {
    return !route.customServer || isOfficialWorldsServer(route.customServer)
  }
  return false
}

/** `decentraland://` scheme the native Explorer / mobile app consumes. */
export function dclMobileAppSchemeHref(route: SceneLandingRoute): string | null {
  if (!canOpenDclMobileApp(route)) return null
  if (route.kind === 'world') {
    return `decentraland://?realm=${encodeURIComponent(route.worldName)}`
  }
  if (route.kind === 'coords') {
    return `decentraland://?position=${route.x},${route.y}`
  }
  return null
}

/** Desktop QR payload — same `decentraland://` deep link the Mobile App button uses. */
export async function paintDclMobileAppQr(img: HTMLImageElement, href: string): Promise<void> {
  img.src = await QRCode.toDataURL(href, {
    width: 160,
    margin: 1,
    errorCorrectionLevel: 'M',
    color: { dark: '#11081c', light: '#ffffff' }
  })
}

/**
 * Hand the current place to the Decentraland mobile app.
 * Android uses an intent URL (Play Store fallback). iOS fires the custom
 * scheme, then the App Store if the OS never backgrounds this page.
 */
export function openDclMobileApp(route: SceneLandingRoute): void {
  const scheme = dclMobileAppSchemeHref(route)
  if (!scheme) return

  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  if (/Android/i.test(ua)) {
    const query = scheme.replace(/^decentraland:\/\/\??/, '')
    window.location.href = `intent://${query}#Intent;scheme=decentraland;package=${DCL_ANDROID_PACKAGE};S.browser_fallback_url=${encodeURIComponent(DCL_ANDROID_STORE)};end`
    return
  }

  handOffToApp(scheme, DCL_IOS_STORE)
}

function handOffToApp(scheme: string, store: string): void {
  let handedOff = false
  const markHandedOff = (): void => {
    handedOff = true
  }
  window.addEventListener('pagehide', markHandedOff)
  window.addEventListener('blur', markHandedOff)
  document.addEventListener('visibilitychange', markHandedOff)

  window.location.href = scheme

  window.setTimeout(() => {
    window.removeEventListener('pagehide', markHandedOff)
    window.removeEventListener('blur', markHandedOff)
    document.removeEventListener('visibilitychange', markHandedOff)
    if (handedOff || document.hidden || document.visibilityState === 'hidden') return
    window.location.href = store
  }, STORE_FALLBACK_MS)
}
