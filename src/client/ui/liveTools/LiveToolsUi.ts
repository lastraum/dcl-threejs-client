/**
 * Live tools HUD: menu actions, poll create/vote/results, Q&A host/ask, projected question.
 */
import type { LiveToolsSession } from '../../../social/LiveToolsSession'
import type { LivePollState, LiveQaItem } from '../../../social/liveToolsWire'
import {
  LIVE_TOOLS_POLL_OPTIONS_MAX,
  LIVE_TOOLS_POLL_OPTIONS_MIN,
  LIVE_TOOLS_QA_TEXT_MAX
} from '../../../social/liveToolsWire'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type LiveToolsUiOptions = {
  session: LiveToolsSession
  onToast?: (message: string) => void
}

export class LiveToolsUi {
  private readonly session: LiveToolsSession
  private readonly onToast?: (message: string) => void
  private modalHost: HTMLElement | null = null
  private projectedEl: HTMLElement | null = null
  private voteBanner: HTMLElement | null = null
  private disposed = false
  private optionCount = 2

  constructor(opts: LiveToolsUiOptions) {
    this.session = opts.session
    this.onToast = opts.onToast
  }

  /** Refresh projected HUD + vote banner from session state. */
  refresh(): void {
    if (this.disposed) return
    this.renderProjected()
    this.renderVoteBanner()
    // If a host panel is open, re-render body
    const hostPanel = this.modalHost?.querySelector('[data-live-tools-panel]')
    if (hostPanel) {
      const kind = hostPanel.getAttribute('data-live-tools-panel')
      if (kind === 'qa-host') this.openQaHostPanel()
      else if (kind === 'poll-results') this.openPollResults()
    }
  }

  openMenuAt(anchor: HTMLElement): void {
    this.closeModal()
    const snap = this.session.snapshot()
    const host = snap.isHost
    const hasOpenPoll = !!snap.poll?.open
    const hasClosedPoll = !!snap.poll && !snap.poll.open

    const menu = document.createElement('div')
    menu.className = 'live-tools-menu'
    menu.setAttribute('role', 'menu')
    const items: Array<{ label: string; action: () => void; disabled?: boolean }> = []

    if (host) {
      items.push({
        label: hasOpenPoll ? 'View poll results…' : 'Start live poll…',
        action: () => {
          this.closeModal()
          if (hasOpenPoll || hasClosedPoll) this.openPollResults()
          else this.openPollCreate()
        }
      })
      items.push({
        label: 'Q&A host…',
        action: () => {
          this.closeModal()
          this.openQaHostPanel()
        }
      })
    } else {
      if (hasOpenPoll && snap.localVotedOption == null) {
        items.push({
          label: 'Answer poll…',
          action: () => {
            this.closeModal()
            this.openPollVote()
          }
        })
      } else if (snap.poll) {
        items.push({
          label: 'View poll…',
          action: () => {
            this.closeModal()
            this.openPollResults()
          }
        })
      }
      items.push({
        label: 'Ask a question…',
        action: () => {
          this.closeModal()
          this.openQaAsk()
        }
      })
    }

    if (!items.length) {
      items.push({
        label: 'No live tools right now',
        action: () => this.closeModal(),
        disabled: true
      })
    }

    menu.innerHTML = items
      .map(
        (it, i) =>
          `<button type="button" class="live-tools-menu__item" role="menuitem" data-i="${i}" ${
            it.disabled ? 'disabled' : ''
          }>${escapeHtml(it.label)}</button>`
      )
      .join('')

    const rect = anchor.getBoundingClientRect()
    menu.style.position = 'fixed'
    menu.style.left = `${Math.min(rect.left, window.innerWidth - 220)}px`
    menu.style.top = `${rect.bottom + 6}px`
    menu.style.zIndex = '12000'

    this.modalHost = document.createElement('div')
    this.modalHost.className = 'live-tools-modal-root'
    this.modalHost.appendChild(menu)
    document.body.appendChild(this.modalHost)

    menu.querySelectorAll<HTMLButtonElement>('[data-i]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const i = Number(btn.dataset.i)
        const it = items[i]
        if (it && !it.disabled) it.action()
      })
    })

    const onDoc = (ev: MouseEvent) => {
      if (!this.modalHost?.contains(ev.target as Node)) {
        document.removeEventListener('mousedown', onDoc, true)
        this.closeModal()
      }
    }
    queueMicrotask(() => document.addEventListener('mousedown', onDoc, true))
  }

  openPollCreate(): void {
    this.closeModal()
    this.optionCount = 2
    this.modalHost = this.mountSheet(`
      <div class="live-tools-sheet" data-live-tools-panel="poll-create" role="dialog" aria-label="Start live poll">
        <header class="live-tools-sheet__header">
          <h2 class="live-tools-sheet__title">Live poll</h2>
          <button type="button" class="live-tools-sheet__close" data-close aria-label="Close">×</button>
        </header>
        <p class="live-tools-sheet__hint">Scene owner only · everyone in this place can vote once.</p>
        <label class="live-tools-field">
          <span>Question</span>
          <input type="text" data-q maxlength="200" placeholder="What should we do next?" />
        </label>
        <div class="live-tools-options" data-options></div>
        <div class="live-tools-sheet__row">
          <button type="button" class="live-tools-btn live-tools-btn--ghost" data-add-opt>+ Option</button>
          <button type="button" class="live-tools-btn live-tools-btn--primary" data-start>Start poll</button>
        </div>
        <p class="live-tools-sheet__error" data-err hidden></p>
      </div>
    `)
    this.renderOptionInputs()
    this.modalHost.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal())
    this.modalHost.querySelector('[data-add-opt]')?.addEventListener('click', () => {
      if (this.optionCount < LIVE_TOOLS_POLL_OPTIONS_MAX) {
        this.optionCount++
        this.renderOptionInputs()
      }
    })
    this.modalHost.querySelector('[data-start]')?.addEventListener('click', () => void this.submitPollCreate())
  }

  openPollVote(): void {
    const poll = this.session.snapshot().poll
    if (!poll?.open) {
      this.onToast?.('No open poll')
      return
    }
    this.closeModal()
    this.modalHost = this.mountSheet(`
      <div class="live-tools-sheet" data-live-tools-panel="poll-vote" role="dialog" aria-label="Vote">
        <header class="live-tools-sheet__header">
          <h2 class="live-tools-sheet__title">Live poll</h2>
          <button type="button" class="live-tools-sheet__close" data-close aria-label="Close">×</button>
        </header>
        <p class="live-tools-sheet__question">${escapeHtml(poll.question)}</p>
        <div class="live-tools-vote-list">
          ${poll.options
            .map(
              (o, i) =>
                `<button type="button" class="live-tools-vote-opt" data-opt="${i}">${escapeHtml(o)}</button>`
            )
            .join('')}
        </div>
        <p class="live-tools-sheet__error" data-err hidden></p>
      </div>
    `)
    this.modalHost.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal())
    this.modalHost.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((btn) => {
      btn.addEventListener('click', () => void this.submitVote(Number(btn.dataset.opt)))
    })
  }

  openPollResults(): void {
    const snap = this.session.snapshot()
    const poll = snap.poll
    if (!poll) {
      this.onToast?.('No poll yet')
      return
    }
    this.closeModal()
    const total = poll.counts.reduce((a, b) => a + b, 0)
    const canVote = poll.open && snap.localVotedOption == null
    this.modalHost = this.mountSheet(`
      <div class="live-tools-sheet" data-live-tools-panel="poll-results" role="dialog" aria-label="Poll results">
        <header class="live-tools-sheet__header">
          <h2 class="live-tools-sheet__title">${poll.open ? 'Live results' : 'Poll closed'}</h2>
          <button type="button" class="live-tools-sheet__close" data-close aria-label="Close">×</button>
        </header>
        <p class="live-tools-sheet__question">${escapeHtml(poll.question)}</p>
        ${
          canVote
            ? `<div class="live-tools-vote-list" style="margin-bottom:12px">
                ${poll.options
                  .map(
                    (o, i) =>
                      `<button type="button" class="live-tools-vote-opt" data-opt="${i}">${escapeHtml(o)}</button>`
                  )
                  .join('')}
              </div>`
            : `<div class="live-tools-results">${this.renderResultBars(poll, total)}</div>`
        }
        ${
          !canVote
            ? `<p class="live-tools-sheet__meta">${total} vote${total === 1 ? '' : 's'}${
                snap.localVotedOption != null ? ' · you voted' : ''
              }</p>`
            : `<p class="live-tools-sheet__meta">Pick an option to vote · live tallies after you vote</p>`
        }
        ${
          snap.isHost
            ? `<div class="live-tools-sheet__row">
                ${
                  poll.open
                    ? `<button type="button" class="live-tools-btn live-tools-btn--primary" data-close-poll>Close poll</button>`
                    : `<button type="button" class="live-tools-btn live-tools-btn--ghost" data-clear-poll>Clear</button>
                       <button type="button" class="live-tools-btn live-tools-btn--primary" data-new-poll>New poll</button>`
                }
              </div>`
            : ''
        }
        <p class="live-tools-sheet__error" data-err hidden></p>
      </div>
    `)
    this.modalHost.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal())
    this.modalHost.querySelectorAll<HTMLButtonElement>('[data-opt]').forEach((btn) => {
      btn.addEventListener('click', () => void this.submitVote(Number(btn.dataset.opt)))
    })
    this.modalHost.querySelector('[data-close-poll]')?.addEventListener('click', () => {
      void this.session.closePoll().then((r) => {
        if (!r.ok) this.onToast?.(r.error)
        else this.openPollResults()
      })
    })
    this.modalHost.querySelector('[data-clear-poll]')?.addEventListener('click', () => {
      void this.session.clearPoll().then(() => this.closeModal())
    })
    this.modalHost.querySelector('[data-new-poll]')?.addEventListener('click', () => {
      void this.session.clearPoll().then(() => this.openPollCreate())
    })
  }

  openQaAsk(): void {
    this.closeModal()
    this.modalHost = this.mountSheet(`
      <div class="live-tools-sheet" data-live-tools-panel="qa-ask" role="dialog" aria-label="Ask a question">
        <header class="live-tools-sheet__header">
          <h2 class="live-tools-sheet__title">Ask a question</h2>
          <button type="button" class="live-tools-sheet__close" data-close aria-label="Close">×</button>
        </header>
        <label class="live-tools-field">
          <span>Your question</span>
          <textarea data-text maxlength="${LIVE_TOOLS_QA_TEXT_MAX}" rows="3" placeholder="Type your question…"></textarea>
        </label>
        <div class="live-tools-sheet__row">
          <button type="button" class="live-tools-btn live-tools-btn--primary" data-send>Send</button>
        </div>
        <p class="live-tools-sheet__error" data-err hidden></p>
      </div>
    `)
    this.modalHost.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal())
    this.modalHost.querySelector('[data-send]')?.addEventListener('click', () => void this.submitAsk())
  }

  openQaHostPanel(): void {
    const snap = this.session.snapshot()
    if (!snap.isHost) {
      this.openQaAsk()
      return
    }
    this.closeModal()
    const list = snap.qaInbox
    this.modalHost = this.mountSheet(`
      <div class="live-tools-sheet live-tools-sheet--wide" data-live-tools-panel="qa-host" role="dialog" aria-label="Q&A host">
        <header class="live-tools-sheet__header">
          <h2 class="live-tools-sheet__title">Q&amp;A</h2>
          <button type="button" class="live-tools-sheet__close" data-close aria-label="Close">×</button>
        </header>
        <p class="live-tools-sheet__hint">
          Project a question on screen for everyone. ${
            snap.projected ? `Showing: “${escapeHtml(snap.projected.text.slice(0, 60))}”` : 'Nothing projected.'
          }
        </p>
        ${
          snap.projected
            ? `<button type="button" class="live-tools-btn live-tools-btn--ghost" data-clear-proj>Clear projected</button>`
            : ''
        }
        <div class="live-tools-qa-list">
          ${
            list.length
              ? list.map((q) => this.renderQaRow(q, snap.projected?.id === q.id)).join('')
              : `<p class="live-tools-sheet__empty">No questions yet — guests can Ask from the ⋯ menu.</p>`
          }
        </div>
      </div>
    `)
    this.modalHost.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal())
    this.modalHost.querySelector('[data-clear-proj]')?.addEventListener('click', () => {
      void this.session.projectQuestion(null).then((r) => {
        if (!r.ok) this.onToast?.(r.error)
        else this.openQaHostPanel()
      })
    })
    this.modalHost.querySelectorAll<HTMLElement>('[data-qa-id]').forEach((row) => {
      const id = row.getAttribute('data-qa-id')!
      const item = list.find((q) => q.id === id)
      if (!item) return
      row.querySelector('[data-project]')?.addEventListener('click', () => {
        void this.session.projectQuestion(item).then((r) => {
          if (!r.ok) this.onToast?.(r.error)
          else {
            this.onToast?.('Question projected')
            this.openQaHostPanel()
          }
        })
      })
      row.querySelector('[data-dismiss]')?.addEventListener('click', () => {
        void this.session.dismissQuestion(id).then(() => this.openQaHostPanel())
      })
    })
  }

  dispose(): void {
    this.disposed = true
    this.closeModal()
    this.projectedEl?.remove()
    this.projectedEl = null
    this.voteBanner?.remove()
    this.voteBanner = null
  }

  private renderQaRow(q: LiveQaItem, isProjected: boolean): string {
    const who = q.name?.trim() || `${q.from.slice(0, 6)}…${q.from.slice(-4)}`
    return `
      <div class="live-tools-qa-row ${isProjected ? 'is-projected' : ''}" data-qa-id="${escapeHtml(q.id)}">
        <div class="live-tools-qa-row__body">
          <p class="live-tools-qa-row__text">${escapeHtml(q.text)}</p>
          <p class="live-tools-qa-row__meta">${escapeHtml(who)}</p>
        </div>
        <div class="live-tools-qa-row__actions">
          <button type="button" class="live-tools-btn live-tools-btn--primary live-tools-btn--sm" data-project>
            ${isProjected ? 'Showing' : 'Project'}
          </button>
          <button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-dismiss>Dismiss</button>
        </div>
      </div>
    `
  }

  private renderResultBars(poll: LivePollState, total: number): string {
    return poll.options
      .map((label, i) => {
        const n = poll.counts[i] ?? 0
        const pct = total > 0 ? Math.round((n / total) * 100) : 0
        return `
          <div class="live-tools-bar">
            <div class="live-tools-bar__label">
              <span>${escapeHtml(label)}</span>
              <span>${n} · ${pct}%</span>
            </div>
            <div class="live-tools-bar__track"><div class="live-tools-bar__fill" style="width:${pct}%"></div></div>
          </div>
        `
      })
      .join('')
  }

  private renderOptionInputs(): void {
    const host = this.modalHost?.querySelector('[data-options]')
    if (!host) return
    const prev: string[] = []
    host.querySelectorAll<HTMLInputElement>('input').forEach((inp) => prev.push(inp.value))
    host.innerHTML = Array.from({ length: this.optionCount }, (_, i) => {
      const ph = i === 0 ? 'Option A' : i === 1 ? 'Option B' : `Option ${i + 1}`
      return `<label class="live-tools-field"><span>Option ${i + 1}</span>
        <input type="text" data-opt-i="${i}" maxlength="80" placeholder="${ph}" value="${escapeHtml(prev[i] ?? '')}" /></label>`
    }).join('')
  }

  private async submitPollCreate(): Promise<void> {
    const q = (this.modalHost?.querySelector('[data-q]') as HTMLInputElement | null)?.value ?? ''
    const opts: string[] = []
    this.modalHost?.querySelectorAll<HTMLInputElement>('[data-opt-i]').forEach((inp) => {
      if (inp.value.trim()) opts.push(inp.value.trim())
    })
    while (opts.length < LIVE_TOOLS_POLL_OPTIONS_MIN) {
      /* need min */
      break
    }
    const r = await this.session.openPoll(q, opts)
    if (!r.ok) {
      this.showErr(r.error)
      return
    }
    this.onToast?.('Poll started')
    this.openPollResults()
  }

  private async submitVote(i: number): Promise<void> {
    const r = await this.session.vote(i)
    if (!r.ok) {
      this.showErr(r.error)
      return
    }
    this.onToast?.('Vote sent')
    // Stay on results so tallies update; re-render panel if open.
    const panel = this.modalHost?.querySelector('[data-live-tools-panel]')
    if (panel?.getAttribute('data-live-tools-panel') === 'poll-results') {
      this.openPollResults()
    } else {
      this.closeModal()
    }
    this.refresh()
  }

  private async submitAsk(): Promise<void> {
    const text = (this.modalHost?.querySelector('[data-text]') as HTMLTextAreaElement | null)?.value ?? ''
    const r = await this.session.askQuestion(text)
    if (!r.ok) {
      this.showErr(r.error)
      return
    }
    this.onToast?.('Question sent')
    this.closeModal()
  }

  private showErr(msg: string): void {
    const el = this.modalHost?.querySelector('[data-err]') as HTMLElement | null
    if (!el) {
      this.onToast?.(msg)
      return
    }
    el.hidden = false
    el.textContent = msg
  }

  private mountSheet(innerHtml: string): HTMLElement {
    const root = document.createElement('div')
    root.className = 'live-tools-modal-root live-tools-modal-root--sheet'
    root.innerHTML = `<div class="live-tools-backdrop" data-backdrop></div>${innerHtml}`
    document.body.appendChild(root)
    root.querySelector('[data-backdrop]')?.addEventListener('click', () => this.closeModal())
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.removeEventListener('keydown', onKey, true)
        this.closeModal()
      }
    }
    window.addEventListener('keydown', onKey, true)
    return root
  }

  private closeModal(): void {
    this.modalHost?.remove()
    this.modalHost = null
  }

  private renderProjected(): void {
    const projected = this.session.snapshot().projected
    if (!projected) {
      this.projectedEl?.remove()
      this.projectedEl = null
      return
    }
    if (!this.projectedEl) {
      this.projectedEl = document.createElement('div')
      this.projectedEl.className = 'live-tools-projected'
      this.projectedEl.setAttribute('role', 'status')
      document.body.appendChild(this.projectedEl)
    }
    const who = projected.name?.trim() || (projected.from ? `${projected.from.slice(0, 6)}…` : '')
    this.projectedEl.innerHTML = `
      <div class="live-tools-projected__badge">Q&amp;A</div>
      <p class="live-tools-projected__text">${escapeHtml(projected.text)}</p>
      ${who ? `<p class="live-tools-projected__from">${escapeHtml(who)}</p>` : ''}
    `
  }

  private renderVoteBanner(): void {
    const snap = this.session.snapshot()
    const show =
      !!snap.poll?.open && snap.localVotedOption == null && !snap.isHost
    if (!show) {
      this.voteBanner?.remove()
      this.voteBanner = null
      return
    }
    if (!this.voteBanner) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'live-tools-vote-banner'
      btn.addEventListener('click', () => this.openPollVote())
      document.body.appendChild(btn)
      this.voteBanner = btn
    }
    this.voteBanner.textContent = 'Live poll — tap to vote'
  }
}
