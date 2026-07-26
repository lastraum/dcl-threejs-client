/**
 * Centered full-viewport overlay for gacha sign / meta-tx progress.
 * Mounted on document.body so it sits above 2D shell and 3D HUD.
 *
 * Multi-step meta-tx: after async work (receipt wait), call
 * `requestGachaSignContinue` so the next `eth_signTypedData` is tied to a click
 * (browsers/wallets often block a second signature without a fresh user gesture).
 */

import { EXPLORER_TX } from './config'
import { escapeHtml } from './format'
import type { TxStep } from './types'

const HOST_ID = 'gacha-sign-overlay-host'

function ensureHost(): HTMLElement {
  let el = document.getElementById(HOST_ID)
  if (!el) {
    el = document.createElement('div')
    el.id = HOST_ID
    el.className = 'gacha-sign-overlay'
    el.hidden = true
    el.setAttribute('role', 'dialog')
    el.setAttribute('aria-modal', 'true')
    el.setAttribute('aria-label', 'Transaction progress')
    document.body.appendChild(el)
  }
  return el
}

function stepsListHtml(steps: readonly TxStep[]): string {
  if (!steps.length) return ''
  return `<ol class="gacha-sign-overlay__list">${steps
    .map((s) => {
      const hash = s.hash
        ? ` <a class="gacha-sign-overlay__tx" href="${EXPLORER_TX}${s.hash}" target="_blank" rel="noopener">${s.hash.slice(0, 10)}…</a>`
        : ''
      const detail = s.detail
        ? ` <span class="gacha-sign-overlay__detail">${escapeHtml(s.detail)}</span>`
        : ''
      const spinner =
        s.status === 'active' ? '<span class="gacha-sign-overlay__spin" aria-hidden="true"></span>' : ''
      const check = s.status === 'done' ? '<span class="gacha-sign-overlay__check" aria-hidden="true">✓</span>' : ''
      return `<li class="gacha-sign-overlay__step is-${s.status}">${spinner}${check}<span class="gacha-sign-overlay__label">${escapeHtml(s.label)}</span>${hash}${detail}</li>`
    })
    .join('')}</ol>`
}

export type GachaSignOverlayState = {
  /** Headline e.g. "Approve & stock" */
  title?: string
  /** Status line e.g. "Stocking 25× …" */
  status?: string
  steps: readonly TxStep[]
  /** Optional primary action (continue to next signature) */
  continueLabel?: string
  onContinue?: () => void
}

let continueHandler: (() => void) | null = null

/** Show or update the centered overlay. Hidden when steps empty and no continue. */
export function syncGachaSignOverlay(state: GachaSignOverlayState | null): void {
  const host = ensureHost()
  continueHandler = null

  if (!state || (state.steps.length === 0 && !state.continueLabel)) {
    host.hidden = true
    host.innerHTML = ''
    document.documentElement.classList.remove('gacha-sign-open')
    return
  }

  const title = state.title?.trim() || 'Confirm in wallet'
  const status = state.status?.trim() || ''
  const cont = state.continueLabel?.trim()
  if (cont && state.onContinue) {
    continueHandler = state.onContinue
  }

  host.innerHTML = `
    <div class="gacha-sign-overlay__backdrop" aria-hidden="true"></div>
    <div class="gacha-sign-overlay__card">
      <div class="gacha-sign-overlay__kicker">Grab bag</div>
      <h2 class="gacha-sign-overlay__title">${escapeHtml(title)}</h2>
      ${status ? `<p class="gacha-sign-overlay__status">${escapeHtml(status)}</p>` : ''}
      ${stepsListHtml(state.steps)}
      ${
        cont
          ? `<button type="button" class="gacha-sign-overlay__continue" data-gacha-sign-continue>${escapeHtml(cont)}</button>
             <p class="gacha-sign-overlay__hint">Click to open the next wallet signature (mint into grab bag).</p>`
          : `<p class="gacha-sign-overlay__hint">Check your wallet / browser extension if a signature prompt is open.</p>`
      }
    </div>
  `
  host.hidden = false
  document.documentElement.classList.add('gacha-sign-open')

  const btn = host.querySelector('[data-gacha-sign-continue]') as HTMLButtonElement | null
  if (btn && continueHandler) {
    const fn = continueHandler
    btn.addEventListener(
      'click',
      (ev) => {
        ev.preventDefault()
        btn.disabled = true
        fn()
      },
      { once: true }
    )
  }
}

/**
 * After an async gap (e.g. approve receipt), wait for a user click before the next
 * eth_signTypedData — restores user-gesture so the second MetaMask prompt appears.
 */
export function requestGachaSignContinue(opts: {
  title?: string
  status: string
  steps: readonly TxStep[]
  buttonLabel?: string
}): Promise<void> {
  return new Promise((resolve) => {
    syncGachaSignOverlay({
      title: opts.title ?? 'Almost done',
      status: opts.status,
      steps: opts.steps,
      continueLabel: opts.buttonLabel ?? 'Sign stock into grab bag',
      onContinue: () => resolve()
    })
  })
}

export function hideGachaSignOverlay(): void {
  continueHandler = null
  syncGachaSignOverlay(null)
}

/**
 * Centered success dialog (stock / deposit complete). Resolves when user clicks Done.
 */
export function showGachaSuccessOverlay(opts: {
  title?: string
  message: string
  detail?: string
  buttonLabel?: string
}): Promise<void> {
  return new Promise((resolve) => {
    const host = ensureHost()
    continueHandler = null
    const title = opts.title?.trim() || 'Success'
    const message = opts.message.trim()
    const detail = opts.detail?.trim()
    const btnLabel = opts.buttonLabel?.trim() || 'Done'

    host.innerHTML = `
      <div class="gacha-sign-overlay__backdrop" aria-hidden="true"></div>
      <div class="gacha-sign-overlay__card gacha-sign-overlay__card--success">
        <div class="gacha-sign-overlay__kicker">Grab bag</div>
        <div class="gacha-sign-overlay__success-icon" aria-hidden="true">✓</div>
        <h2 class="gacha-sign-overlay__title">${escapeHtml(title)}</h2>
        <p class="gacha-sign-overlay__status">${escapeHtml(message)}</p>
        ${detail ? `<p class="gacha-sign-overlay__hint">${escapeHtml(detail)}</p>` : ''}
        <button type="button" class="gacha-sign-overlay__continue" data-gacha-sign-done>${escapeHtml(btnLabel)}</button>
      </div>
    `
    host.hidden = false
    document.documentElement.classList.add('gacha-sign-open')

    const btn = host.querySelector('[data-gacha-sign-done]') as HTMLButtonElement | null
    btn?.addEventListener(
      'click',
      (ev) => {
        ev.preventDefault()
        hideGachaSignOverlay()
        resolve()
      },
      { once: true }
    )
  })
}
