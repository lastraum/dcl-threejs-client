import { APP_VERSION } from '../appVersion'
import { loadProgressMarkdown } from '../dev/progressRegistry'
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
      'Open Dev Progress → Shipped for full notes'
    ]
  }
  return { title, bullets }
}

/** Opens Dev Progress → Shipped (same panel as the </> dev tool). */
type OpenShippedFn = () => void

let openShippedView: OpenShippedFn | null = null

/**
 * Wire the shared Dev Progress panel so toast + profile menu open the Shipped tab
 * instead of a separate highlights sheet.
 */
export function bindWhatsNewShippedOpener(open: OpenShippedFn | null): void {
  openShippedView = open
}

function openShippedChangelog(): boolean {
  if (!openShippedView) return false
  openShippedView()
  return true
}

/**
 * Version toast (auto) + entry points that open Dev Progress → Shipped.
 * PERSIST_ACK=false while testing — dismiss never writes localStorage.
 */
export class WhatsNewToast {
  private host: HTMLElement | null = null
  private toast: HTMLElement | null = null
  private dismissTimer = 0
  /** When true, closing should call markWhatsNewSeen (version-bump flow). */
  private ackOnClose = false

  async maybeShow(): Promise<void> {
    if (!shouldShowWhatsNew()) return
    const { title } = await loadWhatsNewContent()
    this.mountToast(title)
  }

  /** Profile menu / settings — same Shipped view as Dev Progress. */
  openHighlights(): void {
    this.ackOnClose = false
    if (openShippedChangelog()) return
    // Fallback: panel not wired yet (should not happen after AppController.start).
    console.warn('[whats-new] Dev Progress panel not ready — open </> → Shipped')
  }

  private ensureHost(): HTMLElement {
    if (this.host?.isConnected) return this.host
    this.host = document.createElement('div')
    this.host.className = 'whats-new-host'
    this.host.setAttribute('data-whats-new-host', '')
    document.body.appendChild(this.host)
    return this.host
  }

  private mountToast(title: string): void {
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
      ${
        !WHATS_NEW_PERSIST_ACK
          ? '<p class="whats-new-toast__dev-hint">Testing mode — dismiss does not save localStorage</p>'
          : ''
      }
    `

    host.appendChild(this.toast)

    this.toast.querySelector('[data-whats-new-details]')?.addEventListener('click', () => {
      window.clearTimeout(this.dismissTimer)
      this.dismissTimer = 0
      // Same view as Dev Progress → Shipped.
      openShippedChangelog()
      this.ackAndClose()
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

/** Profile menu — open Dev Progress → Shipped anytime. */
export function openWhatsNewFromMenu(): void {
  sharedWhatsNew().openHighlights()
}
