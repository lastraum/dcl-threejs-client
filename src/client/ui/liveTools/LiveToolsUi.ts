/**
 * Live tools HUD — purple (Loot Bag) chrome.
 * Polls + Live Q&A (right accordion, slide-out list, owner answers).
 */
import type { LiveToolsSession } from '../../../social/LiveToolsSession'
import type { LivePollState, LiveQaItem } from '../../../social/liveToolsWire'
import {
  LIVE_TOOLS_POLL_OPTIONS_MAX,
  LIVE_TOOLS_QA_TEXT_MAX,
  LIVE_TOOLS_TRIVIA_OPTIONS_MAX
} from '../../../social/liveToolsWire'

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function shortWallet(a: string): string {
  if (a.length < 12) return a
  return `${a.slice(0, 6)}…${a.slice(-4)}`
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
  private qaTab: HTMLButtonElement | null = null
  private qaDrawer: HTMLElement | null = null
  private qaDrawerOpen = false
  /** Stack for poll + trivia bottom-right panels. */
  private brDock: HTMLElement | null = null
  private pollPanel: HTMLElement | null = null
  private pollComposing = false
  private triviaPanel: HTMLElement | null = null
  private triviaOptionCount = 2
  private disposed = false
  private optionCount = 2

  constructor(opts: LiveToolsUiOptions) {
    this.session = opts.session
    this.onToast = opts.onToast
  }

  /** Refresh projected HUD, Q&A accordion, poll/trivia BR panels. */
  refresh(): void {
    if (this.disposed) return
    this.renderProjected()
    this.syncQaChrome()
    this.syncPollPanel()
    this.syncTriviaPanel()
    if (this.qaDrawerOpen) this.renderQaDrawerBody()
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
        label: hasOpenPoll || hasClosedPoll ? 'Open poll…' : 'Start live poll…',
        action: () => {
          this.closeModal()
          if (hasOpenPoll || hasClosedPoll) {
            this.pollComposing = false
            this.syncPollPanel()
          } else {
            this.pollComposing = true
            this.optionCount = 2
            this.syncPollPanel()
          }
        }
      })
      if (snap.qaActive) {
        items.push({
          label: 'Open Live Q&A…',
          action: () => {
            this.closeModal()
            this.openQaDrawer()
          }
        })
        items.push({
          label: 'End Q&A',
          action: () => {
            this.closeModal()
            void this.session.stopQaSession().then((r) => {
              if (!r.ok) this.onToast?.(r.error)
              else this.onToast?.('Q&A ended')
              this.refresh()
            })
          }
        })
      } else {
        items.push({
          label: 'Start Q&A',
          action: () => {
            this.closeModal()
            void this.session.startQaSession().then((r) => {
              if (!r.ok) this.onToast?.(r.error)
              else {
                this.onToast?.('Live Q&A started')
                this.openQaDrawer()
              }
              this.refresh()
            })
          }
        })
      }
      if (snap.triviaActive) {
        items.push({
          label: 'Open Trivia…',
          action: () => {
            this.closeModal()
            this.syncTriviaPanel()
          }
        })
        items.push({
          label: 'End Trivia…',
          action: () => {
            this.closeModal()
            this.openEndTriviaModal()
          }
        })
      } else {
        items.push({
          label: 'Start Trivia',
          action: () => {
            this.closeModal()
            void this.session.startTrivia().then((r) => {
              if (!r.ok) this.onToast?.(r.error)
              else {
                this.onToast?.('Trivia started')
                this.triviaOptionCount = 2
                this.syncTriviaPanel()
              }
              this.refresh()
            })
          }
        })
      }
    } else {
      if (snap.poll) {
        items.push({
          label: hasOpenPoll && snap.localVotedOption == null ? 'Answer poll…' : 'Open poll…',
          action: () => {
            this.closeModal()
            this.pollComposing = false
            this.syncPollPanel()
          }
        })
      }
      if (snap.qaActive) {
        items.push({
          label: 'Open Live Q&A…',
          action: () => {
            this.closeModal()
            this.openQaDrawer()
          }
        })
      }
      if (snap.triviaActive) {
        items.push({
          label: 'Open Trivia…',
          action: () => {
            this.closeModal()
            this.syncTriviaPanel()
          }
        })
      }
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

  dispose(): void {
    this.disposed = true
    this.closeModal()
    this.projectedEl?.remove()
    this.projectedEl = null
    this.teardownQaChrome()
    this.teardownPollPanel()
    this.teardownTriviaPanel()
    this.teardownBrDock()
  }

  // ── Bottom-right dock (poll + trivia stack) ───────────────────────────────

  private ensureBrDock(): HTMLElement {
    if (!this.brDock) {
      this.brDock = document.createElement('div')
      this.brDock.className = 'live-tools-br-dock'
      document.body.appendChild(this.brDock)
    }
    return this.brDock
  }

  private teardownBrDock(): void {
    if (this.pollPanel || this.triviaPanel) return
    this.brDock?.remove()
    this.brDock = null
  }

  // ── Poll (bottom-right panel, same chrome as trivia) ──────────────────────

  private syncPollPanel(): void {
    const snap = this.session.snapshot()
    // Compose-only (host) or any active/closed poll visible to everyone in the place.
    if (!snap.poll && !(this.pollComposing && snap.isHost)) {
      this.teardownPollPanel()
      return
    }
    const dock = this.ensureBrDock()
    if (!this.pollPanel) {
      this.pollPanel = document.createElement('div')
      this.pollPanel.className = 'live-tools-poll live-tools-br-card'
      this.pollPanel.setAttribute('role', 'region')
      this.pollPanel.setAttribute('aria-label', 'Live poll')
      dock.appendChild(this.pollPanel)
    } else if (this.pollPanel.parentElement !== dock) {
      dock.appendChild(this.pollPanel)
    }
    this.renderPollPanel()
  }

  private teardownPollPanel(): void {
    this.pollPanel?.remove()
    this.pollPanel = null
    this.pollComposing = false
    this.teardownBrDock()
  }

  private renderPollPanel(): void {
    if (!this.pollPanel) return
    const snap = this.session.snapshot()
    const poll = snap.poll

    if (this.pollComposing && snap.isHost && !poll) {
      this.renderPollCompose()
      return
    }
    if (!poll) {
      this.teardownPollPanel()
      return
    }

    const total = poll.counts.reduce((a, b) => a + b, 0)
    const canVote = poll.open && snap.localVotedOption == null

    if (canVote) {
      this.pollPanel.innerHTML = `
        <header class="live-tools-trivia__header">
          <span class="live-tools-trivia__live">POLL</span>
          <span class="live-tools-trivia__hint">Pick one · guest ok</span>
        </header>
        <p class="live-tools-trivia__question">${escapeHtml(poll.question)}</p>
        <div class="live-tools-vote-list live-tools-trivia__vote">
          ${poll.options
            .map(
              (o, i) =>
                `<button type="button" class="live-tools-vote-opt" data-poll-opt="${i}">${escapeHtml(o)}</button>`
            )
            .join('')}
        </div>
        <p class="live-tools-sheet__error" data-err hidden></p>
      `
      this.pollPanel.querySelectorAll<HTMLButtonElement>('[data-poll-opt]').forEach((btn) => {
        btn.addEventListener('click', () => void this.submitVote(Number(btn.dataset.pollOpt)))
      })
      return
    }

    this.pollPanel.innerHTML = `
      <header class="live-tools-trivia__header">
        <span class="live-tools-trivia__live">POLL</span>
        <span class="live-tools-trivia__hint">${poll.open ? 'Live results' : 'Closed'} · ${total} vote${
          total === 1 ? '' : 's'
        }</span>
      </header>
      <p class="live-tools-trivia__question">${escapeHtml(poll.question)}</p>
      <div class="live-tools-results">${this.renderResultBars(poll, total)}</div>
      <p class="live-tools-sheet__meta">${
        snap.localVotedOption != null ? 'You voted' : poll.open ? 'Waiting for votes…' : 'Poll closed'
      }</p>
      ${
        snap.isHost
          ? `<div class="live-tools-trivia__row">
              ${
                poll.open
                  ? `<button type="button" class="live-tools-btn live-tools-btn--primary" data-close-poll>Close poll</button>`
                  : `<button type="button" class="live-tools-btn live-tools-btn--ghost" data-clear-poll>Clear</button>
                     <button type="button" class="live-tools-btn live-tools-btn--primary" data-new-poll>New poll</button>`
              }
            </div>`
          : ''
      }
    `
    this.pollPanel.querySelector('[data-close-poll]')?.addEventListener('click', () => {
      void this.session.closePoll().then((r) => {
        if (!r.ok) this.onToast?.(r.error)
        this.refresh()
      })
    })
    this.pollPanel.querySelector('[data-clear-poll]')?.addEventListener('click', () => {
      void this.session.clearPoll().then(() => {
        this.pollComposing = false
        this.refresh()
      })
    })
    this.pollPanel.querySelector('[data-new-poll]')?.addEventListener('click', () => {
      void this.session.clearPoll().then(() => {
        this.pollComposing = true
        this.optionCount = 2
        this.refresh()
      })
    })
  }

  private renderPollCompose(): void {
    if (!this.pollPanel) return
    const opts = Array.from({ length: this.optionCount }, (_, i) => {
      const ph = i === 0 ? 'Option A' : i === 1 ? 'Option B' : `Option ${i + 1}`
      return `<input type="text" class="live-tools-trivia__opt-input" data-opt-i="${i}" maxlength="80" placeholder="${ph}" />`
    }).join('')
    this.pollPanel.innerHTML = `
      <header class="live-tools-trivia__header">
        <span class="live-tools-trivia__live">POLL</span>
        <span class="live-tools-trivia__hint">Everyone can vote once</span>
      </header>
      <label class="live-tools-field live-tools-trivia__field">
        <span>Question</span>
        <input type="text" data-q maxlength="200" placeholder="What should we do next?" />
      </label>
      <div class="live-tools-trivia__opts">${opts}</div>
      <div class="live-tools-trivia__row">
        <button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-add-opt>+ Option</button>
        <button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-cancel-poll>Cancel</button>
        <button type="button" class="live-tools-btn live-tools-btn--primary" data-start>Start poll</button>
      </div>
      <p class="live-tools-sheet__error" data-err hidden></p>
    `
    this.pollPanel.querySelector('[data-add-opt]')?.addEventListener('click', () => {
      if (this.optionCount < LIVE_TOOLS_POLL_OPTIONS_MAX) {
        this.optionCount++
        this.renderPollCompose()
      }
    })
    this.pollPanel.querySelector('[data-cancel-poll]')?.addEventListener('click', () => {
      this.pollComposing = false
      this.teardownPollPanel()
    })
    this.pollPanel.querySelector('[data-start]')?.addEventListener('click', () => void this.submitPollCreate())
  }

  // ── Trivia (bottom-right panel) ───────────────────────────────────────────

  private syncTriviaPanel(): void {
    const snap = this.session.snapshot()
    if (!snap.triviaActive) {
      this.teardownTriviaPanel()
      return
    }
    const dock = this.ensureBrDock()
    if (!this.triviaPanel) {
      this.triviaPanel = document.createElement('div')
      this.triviaPanel.className = 'live-tools-trivia live-tools-br-card'
      this.triviaPanel.setAttribute('role', 'region')
      this.triviaPanel.setAttribute('aria-label', 'Trivia')
      dock.appendChild(this.triviaPanel)
    } else if (this.triviaPanel.parentElement !== dock) {
      dock.appendChild(this.triviaPanel)
    }
    this.renderTriviaPanel()
  }

  private teardownTriviaPanel(): void {
    this.triviaPanel?.remove()
    this.triviaPanel = null
    this.teardownBrDock()
  }

  private renderTriviaPanel(): void {
    if (!this.triviaPanel) return
    const snap = this.session.snapshot()
    const host = snap.isHost
    const tq = snap.triviaCurrent

    if (host) {
      // Host: compose form when no open/revealed current, else live results + controls
      if (!tq) {
        this.renderTriviaHostCompose()
        return
      }
      if (tq.open && !tq.revealed) {
        this.renderTriviaHostLive(tq, snap.triviaLocalVotedOption)
        return
      }
      // Revealed or closed — show results + next
      this.renderTriviaHostResults(tq)
      return
    }

    // Participant
    if (!tq) {
      this.triviaPanel.innerHTML = `
        <header class="live-tools-trivia__header">
          <span class="live-tools-trivia__live">TRIVIA</span>
          <span class="live-tools-trivia__hint">Waiting for next question…</span>
        </header>`
      return
    }
    if (tq.open && snap.triviaLocalVotedOption == null) {
      this.renderTriviaParticipantVote(tq)
      return
    }
    // Voted or revealed
    this.renderTriviaParticipantView(tq, snap.triviaLocalVotedOption)
  }

  private renderTriviaHostCompose(): void {
    if (!this.triviaPanel) return
    const n = this.triviaOptionCount
    const opts = Array.from({ length: n }, (_, i) => {
      const ph = i === 0 ? 'Option A' : i === 1 ? 'Option B' : `Option ${i + 1}`
      return `
        <div class="live-tools-trivia__opt-row">
          <button type="button" class="live-tools-trivia__correct-pick${
            i === 0 ? ' is-correct' : ''
          }" data-triv-correct="${i}" title="Mark as correct answer" aria-label="Mark option ${
            i + 1
          } as correct" aria-pressed="${i === 0 ? 'true' : 'false'}">
            <span class="live-tools-trivia__correct-radio" aria-hidden="true"></span>
          </button>
          <input type="text" class="live-tools-trivia__opt-input" data-triv-opt="${i}" maxlength="80" placeholder="${ph}" />
        </div>`
    }).join('')
    this.triviaPanel.innerHTML = `
      <header class="live-tools-trivia__header">
        <span class="live-tools-trivia__live">TRIVIA</span>
        <span class="live-tools-trivia__hint">Mark ✓ correct · then Ask</span>
      </header>
      <label class="live-tools-field live-tools-trivia__field">
        <span>Question</span>
        <input type="text" data-triv-q maxlength="200" placeholder="Who was the first…?" />
      </label>
      <div class="live-tools-trivia__opts" data-triv-opts>${opts}</div>
      <div class="live-tools-trivia__row">
        <button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-triv-add>+ Option</button>
        <button type="button" class="live-tools-btn live-tools-btn--primary" data-triv-ask>Ask</button>
      </div>
      <p class="live-tools-sheet__error" data-err hidden></p>
    `
    this.triviaPanel.querySelectorAll<HTMLButtonElement>('[data-triv-correct]').forEach((btn) => {
      btn.addEventListener('click', () => {
        this.triviaPanel?.querySelectorAll('[data-triv-correct]').forEach((b) => {
          const on = b === btn
          b.classList.toggle('is-correct', on)
          b.setAttribute('aria-pressed', on ? 'true' : 'false')
        })
      })
    })
    this.triviaPanel.querySelector('[data-triv-add]')?.addEventListener('click', () => {
      if (this.triviaOptionCount < LIVE_TOOLS_TRIVIA_OPTIONS_MAX) {
        this.triviaOptionCount++
        this.renderTriviaHostCompose()
      }
    })
    this.triviaPanel.querySelector('[data-triv-ask]')?.addEventListener('click', () => {
      void this.submitTriviaAsk()
    })
  }

  private renderTriviaHostLive(
    tq: NonNullable<ReturnType<LiveToolsSession['snapshot']>['triviaCurrent']>,
    localVote: number | null
  ): void {
    if (!this.triviaPanel) return
    const total = tq.counts.reduce((a, b) => a + b, 0)
    this.triviaPanel.innerHTML = `
      <header class="live-tools-trivia__header">
        <span class="live-tools-trivia__live">Q${tq.index}</span>
        <span class="live-tools-trivia__hint">Live · ${total} answer${total === 1 ? '' : 's'}</span>
      </header>
      <p class="live-tools-trivia__question">${escapeHtml(tq.question)}</p>
      <div class="live-tools-results">${this.renderTriviaBars(tq, total)}</div>
      ${
        localVote == null
          ? `<div class="live-tools-vote-list live-tools-trivia__vote">
              ${tq.options
                .map(
                  (o, i) =>
                    `<button type="button" class="live-tools-vote-opt" data-triv-vote="${i}">${escapeHtml(o)}</button>`
                )
                .join('')}
            </div>`
          : `<p class="live-tools-sheet__meta">You answered · live tallies updating</p>`
      }
      <div class="live-tools-trivia__row">
        <button type="button" class="live-tools-btn live-tools-btn--primary" data-triv-reveal>Show results</button>
        <button type="button" class="live-tools-btn live-tools-btn--ghost" data-triv-next>Next question</button>
      </div>
    `
    this.bindTriviaHostActions()
    this.triviaPanel.querySelectorAll<HTMLButtonElement>('[data-triv-vote]').forEach((btn) => {
      btn.addEventListener('click', () => void this.submitTriviaVote(Number(btn.dataset.trivVote)))
    })
  }

  private renderTriviaHostResults(
    tq: NonNullable<ReturnType<LiveToolsSession['snapshot']>['triviaCurrent']>
  ): void {
    if (!this.triviaPanel) return
    const total = tq.counts.reduce((a, b) => a + b, 0)
    this.triviaPanel.innerHTML = `
      <header class="live-tools-trivia__header">
        <span class="live-tools-trivia__live">Q${tq.index}</span>
        <span class="live-tools-trivia__hint">Results · ${total} answer${total === 1 ? '' : 's'}</span>
      </header>
      <p class="live-tools-trivia__question">${escapeHtml(tq.question)}</p>
      <div class="live-tools-results">${this.renderTriviaBars(tq, total)}</div>
      <div class="live-tools-trivia__row">
        <button type="button" class="live-tools-btn live-tools-btn--primary" data-triv-next>Next question</button>
      </div>
    `
    this.bindTriviaHostActions()
  }

  private renderTriviaParticipantVote(
    tq: NonNullable<ReturnType<LiveToolsSession['snapshot']>['triviaCurrent']>
  ): void {
    if (!this.triviaPanel) return
    this.triviaPanel.innerHTML = `
      <header class="live-tools-trivia__header">
        <span class="live-tools-trivia__live">Q${tq.index}</span>
        <span class="live-tools-trivia__hint">Pick an answer</span>
      </header>
      <p class="live-tools-trivia__question">${escapeHtml(tq.question)}</p>
      <div class="live-tools-vote-list live-tools-trivia__vote" data-triv-choices>
        ${tq.options
          .map(
            (o, i) =>
              `<button type="button" class="live-tools-vote-opt" data-triv-choice="${i}">${escapeHtml(o)}</button>`
          )
          .join('')}
      </div>
      <div class="live-tools-trivia__row">
        <button type="button" class="live-tools-btn live-tools-btn--primary" data-triv-submit disabled>Submit</button>
      </div>
      <p class="live-tools-sheet__error" data-err hidden></p>
    `
    let selected: number | null = null
    const submit = this.triviaPanel.querySelector<HTMLButtonElement>('[data-triv-submit]')
    this.triviaPanel.querySelectorAll<HTMLButtonElement>('[data-triv-choice]').forEach((btn) => {
      btn.addEventListener('click', () => {
        selected = Number(btn.dataset.trivChoice)
        this.triviaPanel?.querySelectorAll('[data-triv-choice]').forEach((b) => {
          b.classList.toggle('is-selected', b === btn)
        })
        if (submit) submit.disabled = false
      })
    })
    submit?.addEventListener('click', () => {
      if (selected == null) return
      void this.submitTriviaVote(selected)
    })
  }

  private renderTriviaParticipantView(
    tq: NonNullable<ReturnType<LiveToolsSession['snapshot']>['triviaCurrent']>,
    localVote: number | null
  ): void {
    if (!this.triviaPanel) return
    const total = tq.counts.reduce((a, b) => a + b, 0)
    const showBars = tq.revealed || !tq.open
    this.triviaPanel.innerHTML = `
      <header class="live-tools-trivia__header">
        <span class="live-tools-trivia__live">Q${tq.index}</span>
        <span class="live-tools-trivia__hint">${
          tq.revealed ? 'Results' : localVote != null ? 'Answered · waiting…' : 'Closed'
        }</span>
      </header>
      <p class="live-tools-trivia__question">${escapeHtml(tq.question)}</p>
      ${
        showBars
          ? `<div class="live-tools-results">${this.renderTriviaBars(tq, total)}</div>
             <p class="live-tools-sheet__meta">${total} answer${total === 1 ? '' : 's'}${
               localVote != null ? ` · you picked ${escapeHtml(tq.options[localVote] ?? '')}` : ''
             }</p>`
          : `<p class="live-tools-sheet__meta">You picked “${escapeHtml(
              tq.options[localVote ?? 0] ?? ''
            )}”. Results when the host reveals.</p>`
      }
    `
  }

  private renderTriviaBars(
    tq: NonNullable<ReturnType<LiveToolsSession['snapshot']>['triviaCurrent']>,
    total: number
  ): string {
    const showCorrect = tq.revealed && tq.correctIndex != null
    return tq.options
      .map((label, i) => {
        const n = tq.counts[i] ?? 0
        const pct = total > 0 ? Math.round((n / total) * 100) : 0
        const isCorrect = showCorrect && tq.correctIndex === i
        return `
          <div class="live-tools-bar${isCorrect ? ' live-tools-bar--correct' : ''}">
            <div class="live-tools-bar__label">
              <span>${escapeHtml(label)}${
                isCorrect ? ' <span class="live-tools-bar__correct-tag">Correct</span>' : ''
              }</span>
              <span>${n} · ${pct}%</span>
            </div>
            <div class="live-tools-bar__track"><div class="live-tools-bar__fill" style="width:${pct}%"></div></div>
          </div>
        `
      })
      .join('')
  }

  private bindTriviaHostActions(): void {
    this.triviaPanel?.querySelector('[data-triv-reveal]')?.addEventListener('click', () => {
      void this.session.revealTriviaResults().then((r) => {
        if (!r.ok) this.onToast?.(r.error)
        this.refresh()
      })
    })
    this.triviaPanel?.querySelector('[data-triv-next]')?.addEventListener('click', () => {
      void this.session.nextTriviaQuestion().then((r) => {
        if (!r.ok) this.onToast?.(r.error)
        this.triviaOptionCount = 2
        this.refresh()
      })
    })
  }

  private async submitTriviaAsk(): Promise<void> {
    const q =
      (this.triviaPanel?.querySelector('[data-triv-q]') as HTMLInputElement | null)?.value ?? ''
    // Collect options with original indices so correct pick stays aligned.
    const raw: { text: string; orig: number }[] = []
    this.triviaPanel?.querySelectorAll<HTMLInputElement>('[data-triv-opt]').forEach((inp) => {
      const orig = Number(inp.dataset.trivOpt)
      const text = inp.value.trim()
      if (text) raw.push({ text, orig })
    })
    const opts = raw.map((r) => r.text)
    const correctBtn = this.triviaPanel?.querySelector<HTMLElement>(
      '[data-triv-correct].is-correct'
    )
    const correctOrig = correctBtn ? Number(correctBtn.dataset.trivCorrect) : 0
    // Map original UI index → packed options index after empty rows dropped.
    let correctIndex = raw.findIndex((r) => r.orig === correctOrig)
    if (correctIndex < 0) correctIndex = 0
    const r = await this.session.askTriviaQuestion(q, opts, correctIndex)
    if (!r.ok) {
      const err = this.triviaPanel?.querySelector('[data-err]') as HTMLElement | null
      if (err) {
        err.hidden = false
        err.textContent = r.error
      } else this.onToast?.(r.error)
      return
    }
    this.onToast?.('Question asked')
    this.refresh()
  }

  private async submitTriviaVote(i: number): Promise<void> {
    const r = await this.session.voteTrivia(i)
    if (!r.ok) {
      this.onToast?.(r.error)
      const err = this.triviaPanel?.querySelector('[data-err]') as HTMLElement | null
      if (err) {
        err.hidden = false
        err.textContent = r.error
      }
      return
    }
    this.onToast?.('Answer submitted')
    this.refresh()
  }

  openEndTriviaModal(): void {
    this.closeModal()
    this.modalHost = this.mountSheet(`
      <div class="live-tools-sheet" data-live-tools-panel="trivia-end" role="dialog" aria-label="End Trivia">
        <header class="live-tools-sheet__header">
          <h2 class="live-tools-sheet__title">End Trivia</h2>
          <button type="button" class="live-tools-sheet__close" data-close aria-label="Close">×</button>
        </header>
        <p class="live-tools-sheet__hint">
          End the session for everyone, download a CSV of question tallies, or cancel.
        </p>
        <div class="live-tools-sheet__row live-tools-sheet__row--stack">
          <button type="button" class="live-tools-btn live-tools-btn--primary" data-end-trivia>End Trivia</button>
          <button type="button" class="live-tools-btn live-tools-btn--ghost" data-dl-stats>Download stats</button>
          <button type="button" class="live-tools-btn live-tools-btn--ghost" data-cancel-end>Cancel</button>
        </div>
      </div>
    `)
    this.modalHost.querySelector('[data-close]')?.addEventListener('click', () => this.closeModal())
    this.modalHost.querySelector('[data-cancel-end]')?.addEventListener('click', () => this.closeModal())
    this.modalHost.querySelector('[data-dl-stats]')?.addEventListener('click', () => {
      this.downloadTriviaStats()
    })
    this.modalHost.querySelector('[data-end-trivia]')?.addEventListener('click', () => {
      void this.session.endTrivia().then((r) => {
        if (!r.ok) this.onToast?.(r.error)
        else {
          this.onToast?.('Trivia ended')
          this.closeModal()
          this.refresh()
        }
      })
    })
  }

  private downloadTriviaStats(): void {
    const csv = this.session.buildTriviaStatsCsv()
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `trivia-stats-${Date.now()}.csv`
    a.click()
    URL.revokeObjectURL(url)
    this.onToast?.('Stats downloaded')
  }

  // ── Live Q&A accordion / drawer ───────────────────────────────────────────

  private syncQaChrome(): void {
    const snap = this.session.snapshot()
    if (!snap.qaActive) {
      this.teardownQaChrome()
      return
    }
    this.ensureQaTab()
    if (this.qaDrawerOpen) this.renderQaDrawerBody()
  }

  private ensureQaTab(): void {
    if (this.qaTab) return
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'live-tools-qa-tab live-tools-qa-tab--pulse'
    btn.setAttribute('aria-label', 'Live Q&A')
    btn.innerHTML = `<span class="live-tools-qa-tab__dot" aria-hidden="true"></span><span>Live Q&amp;A</span>`
    btn.addEventListener('click', () => {
      if (this.qaDrawerOpen) this.closeQaDrawer()
      else this.openQaDrawer()
    })
    document.body.appendChild(btn)
    this.qaTab = btn
  }

  private teardownQaChrome(): void {
    this.closeQaDrawer()
    this.qaTab?.remove()
    this.qaTab = null
  }

  openQaDrawer(): void {
    const snap = this.session.snapshot()
    if (!snap.qaActive) return
    this.ensureQaTab()
    this.qaDrawerOpen = true
    this.qaTab?.classList.add('is-open')
    if (!this.qaDrawer) {
      this.qaDrawer = document.createElement('div')
      this.qaDrawer.className = 'live-tools-qa-drawer'
      this.qaDrawer.setAttribute('role', 'dialog')
      this.qaDrawer.setAttribute('aria-label', 'Live Q&A')
      document.body.appendChild(this.qaDrawer)
    }
    this.qaDrawer.classList.add('is-open')
    this.renderQaDrawerBody()
  }

  private closeQaDrawer(): void {
    this.qaDrawerOpen = false
    this.qaTab?.classList.remove('is-open')
    this.qaDrawer?.classList.remove('is-open')
  }

  private renderQaDrawerBody(): void {
    if (!this.qaDrawer) return
    const snap = this.session.snapshot()
    const list = snap.qaInbox
    const host = snap.isHost
    this.qaDrawer.innerHTML = `
      <header class="live-tools-qa-drawer__header">
        <div class="live-tools-qa-drawer__title-row">
          <span class="live-tools-qa-drawer__live">LIVE</span>
          <h2 class="live-tools-qa-drawer__title">Q&amp;A</h2>
        </div>
        <div class="live-tools-qa-drawer__header-actions">
          ${
            host
              ? `<button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-end-qa>End</button>`
              : ''
          }
          <button type="button" class="live-tools-sheet__close" data-close-drawer aria-label="Close">×</button>
        </div>
      </header>
      <div class="live-tools-qa-drawer__list" data-qa-list>
        ${
          list.length
            ? list.map((q) => this.renderQaListItem(q, host)).join('')
            : `<p class="live-tools-sheet__empty">No questions yet — ask below.</p>`
        }
      </div>
      <footer class="live-tools-qa-drawer__compose">
        <input type="text" class="live-tools-qa-drawer__input" data-ask-input maxlength="${LIVE_TOOLS_QA_TEXT_MAX}" placeholder="${
          host ? 'Ask a question as host…' : 'Ask a question…'
        }" />
        <button type="button" class="live-tools-btn live-tools-btn--primary" data-ask-send>Send</button>
      </footer>
      <p class="live-tools-sheet__error live-tools-qa-drawer__err" data-err hidden></p>
    `

    this.qaDrawer.querySelector('[data-close-drawer]')?.addEventListener('click', () => this.closeQaDrawer())
    this.qaDrawer.querySelector('[data-end-qa]')?.addEventListener('click', () => {
      void this.session.stopQaSession().then((r) => {
        if (!r.ok) this.onToast?.(r.error)
        else this.onToast?.('Q&A ended')
        this.refresh()
      })
    })
    const sendAsk = () => void this.submitDrawerAsk()
    this.qaDrawer.querySelector('[data-ask-send]')?.addEventListener('click', sendAsk)
    this.qaDrawer.querySelector('[data-ask-input]')?.addEventListener('keydown', (ev) => {
      if ((ev as KeyboardEvent).key === 'Enter') {
        ev.preventDefault()
        sendAsk()
      }
    })

    this.qaDrawer.querySelectorAll<HTMLElement>('[data-qa-id]').forEach((row) => {
      const id = row.getAttribute('data-qa-id')!
      row.querySelector('[data-project]')?.addEventListener('click', () => {
        const item = list.find((q) => q.id === id)
        if (!item) return
        void this.session.projectQuestion(item).then((r) => {
          if (!r.ok) this.onToast?.(r.error)
          else this.onToast?.('Projected on screen')
          this.refresh()
        })
      })
      row.querySelector('[data-clear-proj]')?.addEventListener('click', () => {
        void this.session.projectQuestion(null).then(() => this.refresh())
      })
      row.querySelector('[data-dismiss]')?.addEventListener('click', () => {
        void this.session.dismissQuestion(id).then(() => this.refresh())
      })
      const answerBtn = row.querySelector('[data-answer-send]')
      const answerInp = row.querySelector<HTMLInputElement>('[data-answer-input]')
      answerBtn?.addEventListener('click', () => {
        const text = answerInp?.value ?? ''
        void this.session.answerQuestion(id, text).then((r) => {
          if (!r.ok) this.onToast?.(r.error)
          else this.refresh()
        })
      })
      answerInp?.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter') {
          ev.preventDefault()
          ;(answerBtn as HTMLElement | null)?.click()
        }
      })
    })
  }

  private renderQaListItem(q: LiveQaItem, host: boolean): string {
    const who = q.name?.trim() || shortWallet(q.from)
    const projected = this.session.snapshot().projected?.id === q.id
    const answered = !!q.answer?.trim()
    return `
      <article class="live-tools-qa-item${projected ? ' is-projected' : ''}${answered ? ' is-answered' : ''}" data-qa-id="${escapeHtml(q.id)}">
        <p class="live-tools-qa-item__q">${escapeHtml(q.text)}</p>
        <p class="live-tools-qa-item__meta">${escapeHtml(who)}</p>
        ${
          answered
            ? `<div class="live-tools-qa-item__answer">
                <span class="live-tools-qa-item__answer-label">Answer</span>
                <p>${escapeHtml(q.answer!)}</p>
                ${
                  q.answeredName
                    ? `<p class="live-tools-qa-item__meta">— ${escapeHtml(q.answeredName)}</p>`
                    : ''
                }
              </div>`
            : ''
        }
        ${
          host
            ? `<div class="live-tools-qa-item__host">
                ${
                  !answered
                    ? `<div class="live-tools-qa-item__answer-row">
                        <input type="text" data-answer-input maxlength="${LIVE_TOOLS_QA_TEXT_MAX}" placeholder="Type an answer…" />
                        <button type="button" class="live-tools-btn live-tools-btn--primary live-tools-btn--sm" data-answer-send>Answer</button>
                      </div>`
                    : ''
                }
                <div class="live-tools-qa-item__actions">
                  <button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-project>
                    ${projected ? 'On screen' : 'Project'}
                  </button>
                  ${
                    projected
                      ? `<button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-clear-proj>Clear stage</button>`
                      : ''
                  }
                  <button type="button" class="live-tools-btn live-tools-btn--ghost live-tools-btn--sm" data-dismiss>Dismiss</button>
                </div>
              </div>`
            : ''
        }
      </article>
    `
  }

  private async submitDrawerAsk(): Promise<void> {
    const inp = this.qaDrawer?.querySelector<HTMLInputElement>('[data-ask-input]')
    const text = inp?.value ?? ''
    const r = await this.session.askQuestion(text)
    if (!r.ok) {
      const err = this.qaDrawer?.querySelector('[data-err]') as HTMLElement | null
      if (err) {
        err.hidden = false
        err.textContent = r.error
      } else this.onToast?.(r.error)
      return
    }
    if (inp) inp.value = ''
    this.refresh()
  }

  // ── Poll helpers ──────────────────────────────────────────────────────────

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

  private async submitPollCreate(): Promise<void> {
    const q = (this.pollPanel?.querySelector('[data-q]') as HTMLInputElement | null)?.value ?? ''
    const opts: string[] = []
    this.pollPanel?.querySelectorAll<HTMLInputElement>('[data-opt-i]').forEach((inp) => {
      if (inp.value.trim()) opts.push(inp.value.trim())
    })
    const r = await this.session.openPoll(q, opts)
    if (!r.ok) {
      const err = this.pollPanel?.querySelector('[data-err]') as HTMLElement | null
      if (err) {
        err.hidden = false
        err.textContent = r.error
      } else this.onToast?.(r.error)
      return
    }
    this.pollComposing = false
    this.onToast?.('Poll started')
    this.refresh()
  }

  private async submitVote(i: number): Promise<void> {
    const r = await this.session.vote(i)
    if (!r.ok) {
      const err = this.pollPanel?.querySelector('[data-err]') as HTMLElement | null
      if (err) {
        err.hidden = false
        err.textContent = r.error
      } else this.onToast?.(r.error)
      return
    }
    this.onToast?.('Vote sent')
    this.refresh()
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
    const who = projected.name?.trim() || (projected.from ? shortWallet(projected.from) : '')
    this.projectedEl.innerHTML = `
      <div class="live-tools-projected__badge">Q&amp;A</div>
      <p class="live-tools-projected__text">${escapeHtml(projected.text)}</p>
      ${who ? `<p class="live-tools-projected__from">${escapeHtml(who)}</p>` : ''}
    `
  }

}
