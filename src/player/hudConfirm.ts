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
    // Above scene-ui / chat dock; must beat pointer-lock canvas hit targets.
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

    card.innerHTML = `
      <h2 id="hud-confirm-title" style="margin:0;font-size:18px;font-weight:650;line-height:1.3">${escapeHtml(title)}</h2>
      <p style="margin:0;font-size:14px;line-height:1.5;opacity:0.9;word-break:break-word;white-space:pre-wrap">${escapeHtml(message)}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px;flex-wrap:wrap">
        <button type="button" data-cancel style="padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);background:transparent;color:#fff;cursor:pointer;font-weight:600;font-size:14px;pointer-events:auto">${escapeHtml(cancelLabel)}</button>
        <button type="button" data-confirm style="padding:10px 16px;border-radius:10px;border:none;background:#ff2d55;color:#fff;cursor:pointer;font-weight:650;font-size:14px;pointer-events:auto">${escapeHtml(confirmLabel)}</button>
      </div>
    `

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

    // Capture-phase so canvas/pointer handlers cannot swallow the click first.
    overlay.addEventListener(
      'pointerdown',
      (e) => {
        e.stopPropagation()
        if (e.target === overlay) finish(false)
      },
      true
    )
    overlay.addEventListener(
      'click',
      (e) => {
        e.stopPropagation()
        if (e.target === overlay) finish(false)
      },
      true
    )
    card.querySelector('[data-cancel]')?.addEventListener(
      'click',
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      },
      true
    )
    card.querySelector('[data-confirm]')?.addEventListener(
      'click',
      (e) => {
        e.preventDefault()
        e.stopPropagation()
        finish(true)
      },
      true
    )
    document.addEventListener('keydown', onKey, true)

    activeConfirm = { finish, overlay }
    overlay.appendChild(card)
    document.body.appendChild(overlay)
    // Re-assert unlock after append (some clients re-lock on click-up of the open_link).
    requestAnimationFrame(() => {
      releasePointerLockForModal()
      ;(card.querySelector('[data-confirm]') as HTMLButtonElement | null)?.focus()
    })
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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
