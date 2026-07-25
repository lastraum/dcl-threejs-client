import { closeHudConfirm } from './hudConfirm'

export type OpenExternalUrlRequest = {
  url: string
}

export type OpenExternalUrlResponse = {
  success: boolean
}

const OVERLAY_ID = 'threejs-external-link-overlay'
const ALLOWED_DOMAINS_KEY = 'threejs-client:allowed-external-domains'

function releasePointerLockForModal(): void {
  try {
    if (document.pointerLockElement) document.exitPointerLock()
  } catch {
    /* ignore */
  }
}

function readAllowedDomains(): Set<string> {
  try {
    const raw = localStorage.getItem(ALLOWED_DOMAINS_KEY)
    if (!raw) return new Set()
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) return new Set()
    return new Set(
      parsed
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.trim().toLowerCase())
        .filter(Boolean)
    )
  } catch {
    return new Set()
  }
}

function rememberAllowedDomain(host: string): void {
  const key = host.trim().toLowerCase()
  if (!key) return
  const set = readAllowedDomains()
  set.add(key)
  try {
    localStorage.setItem(ALLOWED_DOMAINS_KEY, JSON.stringify([...set]))
  } catch {
    /* ignore quota / private mode */
  }
}

function isDomainAllowed(host: string): boolean {
  return readAllowedDomains().has(host.trim().toLowerCase())
}

type ActiveExternalConfirm = {
  finish: (ok: boolean) => void
  overlay: HTMLElement
}

let activeExternalConfirm: ActiveExternalConfirm | null = null

function closeExternalLinkConfirm(): void {
  const active = activeExternalConfirm
  if (active) {
    active.finish(false)
    return
  }
  document.getElementById(OVERLAY_ID)?.remove()
}

/**
 * Explorer-style purple "follow this link?" modal.
 * Resolves true only on Continue.
 */
function showExternalLinkConfirm(url: string, host: string): Promise<boolean> {
  closeExternalLinkConfirm()
  // Also clear generic hud confirm if somehow open.
  closeHudConfirm()
  releasePointerLockForModal()

  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (activeExternalConfirm?.finish === finish) activeExternalConfirm = null
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(ok)
    }

    const overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.className = 'external-link-modal-overlay'
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-labelledby', 'external-link-modal-title')

    const card = document.createElement('div')
    card.className = 'external-link-modal'

    const title = document.createElement('h2')
    title.id = 'external-link-modal-title'
    title.className = 'external-link-modal__title'
    title.textContent = 'Are you sure you want to follow this link?'

    const copy = document.createElement('p')
    copy.className = 'external-link-modal__copy'
    copy.textContent =
      "Continuing will open the link in your browser. Make sure it's a website you trust before proceeding."

    const link = document.createElement('a')
    link.className = 'external-link-modal__url'
    link.href = url
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = url
    // Don't navigate from the dialog itself — Continue handles open.
    link.addEventListener('click', (e) => {
      e.preventDefault()
    })

    const actions = document.createElement('div')
    actions.className = 'external-link-modal__actions'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.className = 'external-link-modal__btn external-link-modal__btn--cancel'
    cancelBtn.textContent = 'Cancel'

    const continueBtn = document.createElement('button')
    continueBtn.type = 'button'
    continueBtn.className = 'external-link-modal__btn external-link-modal__btn--continue'
    continueBtn.textContent = 'Continue'

    actions.append(cancelBtn, continueBtn)

    const allowLabel = document.createElement('label')
    allowLabel.className = 'external-link-modal__allow'
    const allowInput = document.createElement('input')
    allowInput.type = 'checkbox'
    allowInput.addEventListener('click', (e) => e.stopPropagation())
    const allowText = document.createElement('span')
    allowText.textContent = 'Always allow links from this domain'
    allowLabel.append(allowInput, allowText)

    card.append(title, copy, link, actions, allowLabel)
    overlay.appendChild(card)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        if (allowInput.checked) rememberAllowedDomain(host)
        finish(true)
      }
    }

    const onScrim = (e: Event) => {
      if (e.target !== overlay) return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    overlay.addEventListener('pointerdown', onScrim, true)
    overlay.addEventListener('click', onScrim, true)

    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    })
    continueBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (allowInput.checked) rememberAllowedDomain(host)
      finish(true)
    })

    document.addEventListener('keydown', onKey, true)
    activeExternalConfirm = { finish, overlay }
    document.body.appendChild(overlay)

    requestAnimationFrame(() => {
      releasePointerLockForModal()
      continueBtn.focus()
    })
    window.setTimeout(() => releasePointerLockForModal(), 50)
  })
}

/** DCL `RestrictedActions.openExternalUrl` — http/https only, HUD confirm then new tab. */
export async function openExternalUrl(request: OpenExternalUrlRequest): Promise<boolean> {
  const url = request.url?.trim()
  if (!url) return false

  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return false
  }

  const host = parsed.hostname
  // Trusted domain shortcut (user previously checked "Always allow…").
  if (isDomainAllowed(host)) {
    const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer')
    return opened !== null
  }

  // Scene worker awaits this RPC — never leave it hung.
  const CONFIRM_TIMEOUT_MS = 90_000
  let timedOut = false
  const timeout = window.setTimeout(() => {
    timedOut = true
    closeExternalLinkConfirm()
  }, CONFIRM_TIMEOUT_MS)

  let ok = false
  try {
    ok = await showExternalLinkConfirm(parsed.href, host)
  } finally {
    window.clearTimeout(timeout)
  }
  if (timedOut || !ok) return false

  const opened = window.open(parsed.href, '_blank', 'noopener,noreferrer')
  return opened !== null
}
