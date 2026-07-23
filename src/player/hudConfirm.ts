/**
 * In-world HUD confirmation (RestrictedActions changeRealm / openExternalUrl).
 * Replaces window.confirm so scene prompts match Explorer-style overlays.
 *
 * Critical: exit pointer-lock before showing — otherwise clicks stay on the canvas
 * and the faded scrim never receives Open/Cancel (worker openExternalUrl RPC hangs
 * → scene freeze). Seen on CBD Plaza Discord Button (open_link).
 */

const OVERLAY_ID = 'threejs-hud-confirm-overlay'

export type HudConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
}

type ActiveConfirm = {
  finish: (ok: boolean) => void
  overlay: HTMLElement
}

let activeConfirm: ActiveConfirm | null = null

function releasePointerLockForModal(): void {
  try {
    if (document.pointerLockElement) document.exitPointerLock()
  } catch {
    /* ignore */
  }
}

export function showHudConfirm(options: HudConfirmOptions): Promise<boolean> {
  // Cancel any prior dialog so its promise always settles (never hang a worker RPC).
  closeHudConfirm()
  releasePointerLockForModal()

  const title = options.title.trim() || 'Confirm'
  const message = options.message.trim()
  const confirmLabel = options.confirmLabel?.trim() || 'OK'
  const cancelLabel = options.cancelLabel?.trim() || 'Cancel'

  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      if (activeConfirm?.finish === finish) activeConfirm = null
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(ok)
    }

    const overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-labelledby', 'hud-confirm-title')
    // Above --z-top-modal (10000) and client HUD; must beat canvas / scene-ui.
    overlay.style.cssText = [
      'position:fixed',
      'inset:0',
      'z-index:10060',
      'display:flex',
      'align-items:center',
      'justify-content:center',
      'background:rgba(0,0,0,0.62)',
      'padding:24px',
      'font-family:Inter,system-ui,-apple-system,sans-serif',
      'pointer-events:auto',
      'cursor:default'
    ].join(';')

    const card = document.createElement('div')
    card.style.cssText = [
      'max-width:420px',
      'width:100%',
      'background:linear-gradient(165deg,#1c1c28 0%,#12121a 100%)',
      'color:#f2f2f5',
      'border-radius:16px',
      'box-shadow:0 20px 56px rgba(0,0,0,0.55)',
      'border:1px solid rgba(255,255,255,0.1)',
      'padding:22px 22px 18px',
      'display:flex',
      'flex-direction:column',
      'gap:14px',
      'pointer-events:auto',
      'cursor:default'
    ].join(';')

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = cancelLabel
    cancelBtn.style.cssText =
      'padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);background:transparent;color:#fff;cursor:pointer;font-weight:600;font-size:14px;pointer-events:auto'

    const confirmBtn = document.createElement('button')
    confirmBtn.type = 'button'
    confirmBtn.textContent = confirmLabel
    confirmBtn.style.cssText =
      'padding:10px 16px;border-radius:10px;border:none;background:#ff2d55;color:#fff;cursor:pointer;font-weight:650;font-size:14px;pointer-events:auto'

    const titleEl = document.createElement('h2')
    titleEl.id = 'hud-confirm-title'
    titleEl.style.cssText = 'margin:0;font-size:18px;font-weight:650;line-height:1.3'
    titleEl.textContent = title

    const msgEl = document.createElement('p')
    msgEl.style.cssText =
      'margin:0;font-size:14px;line-height:1.5;opacity:0.9;word-break:break-word;white-space:pre-wrap'
    msgEl.textContent = message

    const row = document.createElement('div')
    row.style.cssText =
      'display:flex;gap:10px;justify-content:flex-end;margin-top:4px;flex-wrap:wrap'
    row.append(cancelBtn, confirmBtn)

    card.append(titleEl, msgEl, row)

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        e.stopPropagation()
        finish(true)
      }
    }

    // Scrim only: do NOT stopPropagation on card/button hits — that made Open/Cancel dead
    // (capture-phase overlay handler ran first and blocked button listeners).
    const onScrim = (e: Event) => {
      if (e.target !== overlay) return
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    }
    overlay.addEventListener('pointerdown', onScrim, true)
    overlay.addEventListener('click', onScrim, true)

    // Bubble phase on the buttons themselves — reliable after pointer-lock exit.
    cancelBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    })
    confirmBtn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      finish(true)
    })
    // pointerup as backup if a parent steals click
    cancelBtn.addEventListener('pointerup', (e) => {
      e.preventDefault()
      e.stopPropagation()
      finish(false)
    })
    confirmBtn.addEventListener('pointerup', (e) => {
      e.preventDefault()
      e.stopPropagation()
      finish(true)
    })

    document.addEventListener('keydown', onKey, true)

    activeConfirm = { finish, overlay }
    overlay.appendChild(card)
    document.body.appendChild(overlay)
    // Re-assert unlock after append (some clients re-lock on click-up of the open_link).
    requestAnimationFrame(() => {
      releasePointerLockForModal()
      confirmBtn.focus()
    })
    // Second frame: pointer-lock can re-engage after the scene click that opened the link.
    window.setTimeout(() => releasePointerLockForModal(), 50)
  })
}

/** Dismiss overlay and settle the pending promise as cancel (never leave RPC hanging). */
export function closeHudConfirm(): void {
  const active = activeConfirm
  if (active) {
    active.finish(false)
    return
  }
  document.getElementById(OVERLAY_ID)?.remove()
}

export function isHudConfirmOpen(): boolean {
  return activeConfirm !== null || document.getElementById(OVERLAY_ID) !== null
}
