/**
 * In-world HUD confirmation (RestrictedActions changeRealm / openExternalUrl).
 * Replaces window.confirm so scene prompts match Explorer-style overlays.
 */

const OVERLAY_ID = 'threejs-hud-confirm-overlay'

export type HudConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
}

export function showHudConfirm(options: HudConfirmOptions): Promise<boolean> {
  closeHudConfirm()

  const title = options.title.trim() || 'Confirm'
  const message = options.message.trim()
  const confirmLabel = options.confirmLabel?.trim() || 'OK'
  const cancelLabel = options.cancelLabel?.trim() || 'Cancel'

  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      overlay.remove()
      resolve(ok)
    }

    const overlay = document.createElement('div')
    overlay.id = OVERLAY_ID
    overlay.setAttribute('role', 'dialog')
    overlay.setAttribute('aria-modal', 'true')
    overlay.setAttribute('aria-labelledby', 'hud-confirm-title')
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
      'pointer-events:auto'
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
      'gap:14px'
    ].join(';')

    card.innerHTML = `
      <h2 id="hud-confirm-title" style="margin:0;font-size:18px;font-weight:650;line-height:1.3">${escapeHtml(title)}</h2>
      <p style="margin:0;font-size:14px;line-height:1.5;opacity:0.9;word-break:break-word;white-space:pre-wrap">${escapeHtml(message)}</p>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:4px;flex-wrap:wrap">
        <button type="button" data-cancel style="padding:10px 16px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);background:transparent;color:#fff;cursor:pointer;font-weight:600;font-size:14px">${escapeHtml(cancelLabel)}</button>
        <button type="button" data-confirm style="padding:10px 16px;border-radius:10px;border:none;background:#ff2d55;color:#fff;cursor:pointer;font-weight:650;font-size:14px">${escapeHtml(confirmLabel)}</button>
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

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) finish(false)
    })
    card.querySelector('[data-cancel]')?.addEventListener('click', () => finish(false))
    card.querySelector('[data-confirm]')?.addEventListener('click', () => finish(true))
    document.addEventListener('keydown', onKey, true)

    overlay.appendChild(card)
    document.body.appendChild(overlay)
    ;(card.querySelector('[data-confirm]') as HTMLButtonElement | null)?.focus()
  })
}

export function closeHudConfirm(): void {
  document.getElementById(OVERLAY_ID)?.remove()
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
