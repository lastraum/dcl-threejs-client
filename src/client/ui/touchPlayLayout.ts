/**
 * 3D play touch chrome (phone + iPad) — not window-width 767 alone.
 *
 * iPadOS 13+ often reports as Macintosh desktop UA; maxTouchPoints is the tell.
 * Force: `?touch=1` / `?mobile=1` / `?ipad=1`. Off: `?notouch` / `?nomobile`.
 */

const PHONE_MAX_WIDTH_PX = 767

function readSearch(): URLSearchParams | null {
  if (typeof window === 'undefined') return null
  return new URLSearchParams(window.location.search)
}

function forceOff(): boolean {
  const params = readSearch()
  if (!params) return false
  return params.has('notouch') || params.has('nomobile')
}

function forceOn(): boolean {
  const params = readSearch()
  if (!params) return false
  return params.has('touch') || params.has('mobile') || params.has('ipad')
}

/** Real iPad, including iPadOS “Request Desktop Website”. */
export function isIpadDevice(): boolean {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent || ''
  if (/iPad/i.test(ua)) return true
  const maxTouch = navigator.maxTouchPoints ?? 0
  if (maxTouch > 1 && /Mac/i.test(navigator.platform || ua)) return true
  return false
}

function isCoarseNoHover(): boolean {
  if (typeof window === 'undefined') return false
  return (
    window.matchMedia('(pointer: coarse)').matches && window.matchMedia('(hover: none)').matches
  )
}

/** iPad / large tablet — larger HUD hit targets. */
export function isTabletPlayLayout(): boolean {
  if (typeof window === 'undefined') return false
  if (forceOff()) return false
  if (readSearch()?.has('ipad')) return true
  if (isIpadDevice()) return true
  if (!isCoarseNoHover()) return false
  const short = Math.min(window.innerWidth, window.innerHeight)
  const long = Math.max(window.innerWidth, window.innerHeight)
  return short >= 600 && long >= 900 && window.innerWidth > PHONE_MAX_WIDTH_PX
}

/** Phone, iPad, or forced touch — 3D FABs, joystick, mobile HUD. */
export function isTouchPlayLayout(): boolean {
  if (typeof window === 'undefined') return false
  if (forceOff()) return false
  if (forceOn()) return true
  if (isIpadDevice()) return true
  if (window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH_PX}px)`).matches) return true
  if (isTabletPlayLayout()) return true
  return false
}

/** Subscribe to width / pointer / orientation so iPad rotation re-applies chrome. */
export function subscribeTouchPlayLayout(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => undefined
  const mqs = [
    window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH_PX}px)`),
    window.matchMedia('(pointer: coarse)'),
    window.matchMedia('(hover: none)')
  ]
  const handler = (): void => onChange()
  for (const mq of mqs) mq.addEventListener('change', handler)
  window.addEventListener('resize', handler)
  return () => {
    for (const mq of mqs) mq.removeEventListener('change', handler)
    window.removeEventListener('resize', handler)
  }
}
