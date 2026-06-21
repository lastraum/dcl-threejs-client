import { renderQuality, RenderQualityTier } from '../rendering/RenderQualitySettings'
import type * as THREE from 'three'

const BODY_CLASS = 'mobile-portrait'
const MQ_PORTRAIT = '(max-width: 900px) and (orientation: portrait)'
const MQ_COARSE = '(hover: none) and (pointer: coarse)'

function readForceMobile(): boolean | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  if (params.has('mobile')) return true
  if (params.has('desktop')) return false
  return null
}

/** True when the client should use the mobile portrait HUD + touch controls. */
export function isMobilePortrait(): boolean {
  const forced = readForceMobile()
  if (forced !== null) return forced
  if (typeof window === 'undefined') return false
  return window.matchMedia(MQ_PORTRAIT).matches && window.matchMedia(MQ_COARSE).matches
}

/** Sync `mobile-portrait` on `<body>` and layout tokens for panel anchoring. */
export function syncMobilePortraitClass(): boolean {
  const on = isMobilePortrait()
  document.body.classList.toggle(BODY_CLASS, on)
  if (on) {
    document.documentElement.style.setProperty('--client-sidebar-w', '0px')
    document.documentElement.style.setProperty('--client-ui-gap', '0px')
    document.documentElement.style.setProperty(
      '--client-safe-left',
      'max(12px, env(safe-area-inset-left, 0px))'
    )
  }
  return on
}

let resizeListener: (() => void) | null = null

/** Call once at boot — keeps body class in sync on rotate / resize. */
export function initMobilePortraitLayout(): boolean {
  const on = syncMobilePortraitClass()
  if (resizeListener) return on
  resizeListener = () => syncMobilePortraitClass()
  window.addEventListener('resize', resizeListener, { passive: true })
  window.addEventListener('orientationchange', resizeListener, { passive: true })
  return on
}

export function disposeMobilePortraitLayout(): void {
  if (resizeListener) {
    window.removeEventListener('resize', resizeListener)
    window.removeEventListener('orientationchange', resizeListener)
    resizeListener = null
  }
  document.body.classList.remove(BODY_CLASS)
}

/** Lower pixel ratio, light tier, no shadow pass — mobile GPU headroom. */
export function applyMobileGraphics(renderer: THREE.WebGLRenderer): void {
  renderQuality.setTier(RenderQualityTier.Low)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1))
  renderer.shadowMap.enabled = false
}