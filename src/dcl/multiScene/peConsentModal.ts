/**
 * Explorer-style portable experience activate modal.
 * Thumbnail + SMART badge, permissions from scene.json, NO / YES.
 */
import type { PeCandidate } from './types'
import { permissionDisplayList } from './pePermissions'

const OVERLAY_ID = 'threejs-pe-consent-overlay'

export type PeConsentModalOptions = {
  candidate: PeCandidate
  /** Extra footer note (e.g. more PEs available). */
  moreCount?: number
}

export function closePeConsentModal(): void {
  document.getElementById(OVERLAY_ID)?.remove()
}

/**
 * Show activate-PEX modal. Resolves true on YES, false on NO / dismiss.
 */
export function showPeConsentModal(options: PeConsentModalOptions): Promise<boolean> {
  closePeConsentModal()

  const { candidate } = options
  const title = candidate.title.trim() || 'Portable Experience'
  const permissions = permissionDisplayList(candidate.permissions ?? [])
  const more =
    options.moreCount && options.moreCount > 0
      ? `+${options.moreCount} more available in Smart wearables menu.`
      : ''

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
    overlay.setAttribute('aria-labelledby', 'pe-consent-title')
    overlay.className = 'pe-consent-overlay'

    const card = document.createElement('div')
    card.className = 'pe-consent-card'

    const thumbSrc = candidate.thumbnailUrl || candidate.iconUrl || ''
    const permHtml =
      permissions.length > 0
        ? permissions
            .map(
              (p) => `
          <li class="pe-consent-card__perm">
            <span class="pe-consent-card__bullet" aria-hidden="true"></span>
            <span class="pe-consent-card__perm-text">${escapeHtml(p.label)}${
                p.showInfo
                  ? ' <span class="pe-consent-card__info" title="May request wallet signatures or transactions">ⓘ</span>'
                  : ''
              }</span>
          </li>`
            )
            .join('')
        : `<li class="pe-consent-card__perm pe-consent-card__perm--muted">
            <span class="pe-consent-card__bullet" aria-hidden="true"></span>
            <span class="pe-consent-card__perm-text">No special permissions requested</span>
          </li>`

    card.innerHTML = `
      <div class="pe-consent-card__thumb-wrap">
        <div class="pe-consent-card__thumb">
          ${
            thumbSrc
              ? `<img src="${escapeAttr(thumbSrc)}" alt="" class="pe-consent-card__thumb-img" />`
              : `<div class="pe-consent-card__thumb-placeholder" aria-hidden="true"></div>`
          }
          <span class="pe-consent-card__smart"><span class="pe-consent-card__smart-bolt" aria-hidden="true">⚡</span> SMART</span>
        </div>
      </div>
      <h2 id="pe-consent-title" class="pe-consent-card__title">
        Do you want to activate the ${escapeHtml(title)} Portable Experience (PEX)?
      </h2>
      <p class="pe-consent-card__lead">The PEX linked to this Wearable can:</p>
      <ul class="pe-consent-card__perms">${permHtml}</ul>
      ${more ? `<p class="pe-consent-card__more">${escapeHtml(more)}</p>` : ''}
      <div class="pe-consent-card__actions">
        <button type="button" class="pe-consent-card__btn pe-consent-card__btn--no" data-cancel>NO</button>
        <button type="button" class="pe-consent-card__btn pe-consent-card__btn--yes" data-confirm>YES</button>
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

    // Broken thumbnail → placeholder
    const img = card.querySelector('.pe-consent-card__thumb-img') as HTMLImageElement | null
    if (img) {
      img.addEventListener('error', () => {
        const ph = document.createElement('div')
        ph.className = 'pe-consent-card__thumb-placeholder'
        ph.setAttribute('aria-hidden', 'true')
        img.replaceWith(ph)
      })
    }

    overlay.appendChild(card)
    document.body.appendChild(overlay)
    ;(card.querySelector('[data-confirm]') as HTMLButtonElement | null)?.focus()
  })
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;')
}
