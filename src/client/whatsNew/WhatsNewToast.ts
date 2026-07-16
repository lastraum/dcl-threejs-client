import { APP_VERSION } from '../appVersion'
import { loadProgressMarkdown, progressBrowseUrl } from '../dev/progressRegistry'
import { parseLatestWhatsNew, type WhatsNewBlock } from './parseWhatsNew'
import {
  markWhatsNewSeen,
  shouldShowWhatsNew,
  WHATS_NEW_PERSIST_ACK
} from './whatsNewStorage'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/**
 * Bottom toast + optional highlights sheet when the client build is new
 * vs last-seen version. During testing PERSIST_ACK is false so the toast
 * always returns and dismiss does not write localStorage.
 */
export class WhatsNewToast {
  private host: HTMLElement | null = null
  private toast: HTMLElement | null = null
  private sheet: HTMLElement | null = null
  private dismissTimer = 0
  private block: WhatsNewBlock | null = null

  async maybeShow(): Promise<void> {
    if (!shouldShowWhatsNew()) return

    let bullets: string[] = []
    let title = 'Client update'
    try {
      const { markdown } = await loadProgressMarkdown()
      this.block = parseLatestWhatsNew(markdown)
      if (this.block) {
        bullets = this.block.bullets
        title = this.block.milestoneTitle || title
      }
    } catch {
      /* still show version toast */
    }

    if (!bullets.length) {
      bullets = [
        'Performance and reliability improvements',
        'See full notes in Dev Progress → Shipped'
      ]
    }

    this.mount(title, bullets)
  }

  private mount(title: string, bullets: string[]): void {
    this.dispose()

    this.host = document.createElement('div')
    this.host.className = 'whats-new-host'
    this.host.setAttribute('data-whats-new-host', '')

    this.toast = document.createElement('div')
    this.toast.className = 'whats-new-toast'
    this.toast.setAttribute('role', 'status')
    this.toast.innerHTML = `
      <div class="whats-new-toast__inner">
        <div class="whats-new-toast__copy">
          <span class="whats-new-toast__kicker">Updated · v${escapeHtml(APP_VERSION)}</span>
          <span class="whats-new-toast__title">${escapeHtml(title)}</span>
        </div>
        <div class="whats-new-toast__actions">
          <button type="button" class="whats-new-toast__btn whats-new-toast__btn--primary" data-whats-new-details>
            What's new
          </button>
          <button type="button" class="whats-new-toast__btn whats-new-toast__btn--ghost" data-whats-new-dismiss aria-label="Dismiss">
            Dismiss
          </button>
        </div>
      </div>
    `

    this.sheet = document.createElement('div')
    this.sheet.className = 'whats-new-sheet'
    this.sheet.hidden = true
    this.sheet.setAttribute('role', 'dialog')
    this.sheet.setAttribute('aria-modal', 'true')
    this.sheet.setAttribute('aria-label', "What's new")
    const list = bullets.map((b) => `<li>${escapeHtml(b)}</li>`).join('')
    this.sheet.innerHTML = `
      <div class="whats-new-sheet__backdrop" data-whats-new-close></div>
      <div class="whats-new-sheet__panel">
        <header class="whats-new-sheet__header">
          <div>
            <p class="whats-new-sheet__kicker">v${escapeHtml(APP_VERSION)}</p>
            <h2 class="whats-new-sheet__title">${escapeHtml(title)}</h2>
          </div>
          <button type="button" class="whats-new-sheet__close" data-whats-new-close aria-label="Close">&times;</button>
        </header>
        <ul class="whats-new-sheet__list">${list}</ul>
        <footer class="whats-new-sheet__footer">
          <a class="whats-new-sheet__link" href="${escapeHtml(progressBrowseUrl())}" target="_blank" rel="noopener">
            Full progress log
          </a>
          <button type="button" class="whats-new-toast__btn whats-new-toast__btn--primary" data-whats-new-close>
            Got it
          </button>
        </footer>
        ${
          WHATS_NEW_PERSIST_ACK
            ? ''
            : '<p class="whats-new-sheet__dev">Testing mode — dismiss does not save localStorage</p>'
        }
      </div>
    `

    this.host.append(this.toast, this.sheet)
    document.body.appendChild(this.host)

    this.toast.querySelector('[data-whats-new-details]')?.addEventListener('click', () => {
      this.openSheet()
    })
    this.toast.querySelector('[data-whats-new-dismiss]')?.addEventListener('click', () => {
      this.ackAndClose()
    })
    this.sheet.querySelectorAll('[data-whats-new-close]').forEach((el) => {
      el.addEventListener('click', () => this.ackAndClose())
    })

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.toast?.classList.add('whats-new-toast--visible')
      })
    })

    // Long dwell while testing; production can shorten later.
    this.dismissTimer = window.setTimeout(() => this.ackAndClose(), 14_000)
  }

  private openSheet(): void {
    window.clearTimeout(this.dismissTimer)
    this.dismissTimer = 0
    if (this.sheet) this.sheet.hidden = false
    this.toast?.classList.remove('whats-new-toast--visible')
  }

  private ackAndClose(): void {
    markWhatsNewSeen(APP_VERSION)
    this.dispose()
  }

  dispose(): void {
    window.clearTimeout(this.dismissTimer)
    this.dismissTimer = 0
    this.host?.remove()
    this.host = null
    this.toast = null
    this.sheet = null
  }
}

/** Fire-and-forget entry from bootstrap. */
export function maybeShowWhatsNewToast(): void {
  void new WhatsNewToast().maybeShow()
}
