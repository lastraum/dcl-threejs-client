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

async function loadWhatsNewContent(): Promise<{ title: string; bullets: string[] }> {
  let bullets: string[] = []
  let title = 'Client update'
  try {
    const { markdown } = await loadProgressMarkdown()
    const block: WhatsNewBlock | null = parseLatestWhatsNew(markdown)
    if (block) {
      bullets = block.bullets
      title = block.milestoneTitle || title
    }
  } catch {
    /* fallback bullets */
  }
  if (!bullets.length) {
    bullets = [
      'Performance and reliability improvements',
      'See full notes in Dev Progress → Shipped'
    ]
  }
  return { title, bullets }
}

/**
 * Version toast (auto) + highlights sheet (toast button or profile menu).
 * PERSIST_ACK=false while testing — dismiss never writes localStorage.
 */
export class WhatsNewToast {
  private host: HTMLElement | null = null
  private toast: HTMLElement | null = null
  private sheet: HTMLElement | null = null
  private dismissTimer = 0
  /** When true, closing should call markWhatsNewSeen (version-bump flow). */
  private ackOnClose = false

  async maybeShow(): Promise<void> {
    if (!shouldShowWhatsNew()) return
    const { title, bullets } = await loadWhatsNewContent()
    this.mountToast(title, bullets)
  }

  /** Profile menu / always-available entry — opens highlights sheet only. */
  async openHighlights(): Promise<void> {
    const { title, bullets } = await loadWhatsNewContent()
    this.mountSheetOnly(title, bullets)
  }

  private ensureHost(): HTMLElement {
    if (this.host?.isConnected) return this.host
    this.host = document.createElement('div')
    this.host.className = 'whats-new-host'
    this.host.setAttribute('data-whats-new-host', '')
    document.body.appendChild(this.host)
    return this.host
  }

  private mountToast(title: string, bullets: string[]): void {
    this.dispose()
    this.ackOnClose = true
    const host = this.ensureHost()

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

    this.buildSheet(title, bullets, /* showDevNote */ true)
    host.append(this.toast, this.sheet!)

    this.toast.querySelector('[data-whats-new-details]')?.addEventListener('click', () => {
      this.openSheet()
    })
    this.toast.querySelector('[data-whats-new-dismiss]')?.addEventListener('click', () => {
      this.ackAndClose()
    })

    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        this.toast?.classList.add('whats-new-toast--visible')
      })
    })

    this.dismissTimer = window.setTimeout(() => this.ackAndClose(), 14_000)
  }

  private mountSheetOnly(title: string, bullets: string[]): void {
    this.dispose()
    // Manual open — do not mark version seen (user can re-open anytime).
    this.ackOnClose = false
    const host = this.ensureHost()
    this.buildSheet(title, bullets, /* showDevNote */ false)
    host.append(this.sheet!)
    this.openSheet()
  }

  private buildSheet(title: string, bullets: string[], showDevNote: boolean): void {
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
          showDevNote && !WHATS_NEW_PERSIST_ACK
            ? '<p class="whats-new-sheet__dev">Testing mode — dismiss does not save localStorage</p>'
            : ''
        }
      </div>
    `
    this.sheet.querySelectorAll('[data-whats-new-close]').forEach((el) => {
      el.addEventListener('click', () => this.ackAndClose())
    })
  }

  private openSheet(): void {
    window.clearTimeout(this.dismissTimer)
    this.dismissTimer = 0
    if (this.sheet) this.sheet.hidden = false
    this.toast?.classList.remove('whats-new-toast--visible')
  }

  private ackAndClose(): void {
    if (this.ackOnClose) markWhatsNewSeen(APP_VERSION)
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

let shared: WhatsNewToast | null = null

function sharedWhatsNew(): WhatsNewToast {
  if (!shared) shared = new WhatsNewToast()
  return shared
}

/** Fire-and-forget entry from bootstrap. */
export function maybeShowWhatsNewToast(): void {
  void sharedWhatsNew().maybeShow()
}

/** Profile menu — open highlights sheet anytime. */
export function openWhatsNewFromMenu(): void {
  void sharedWhatsNew().openHighlights()
}
