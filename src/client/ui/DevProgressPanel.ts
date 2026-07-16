import { APP_VERSION } from '../appVersion'
import {
  loadClaimsRegistry,
  WORKFLOW_STAGE_LABEL,
  WORKFLOW_STAGE_ORDER,
  type ClaimsLoadResult,
  type WorkflowItem,
  type WorkflowStage
} from '../dev/claimsRegistry'
import {
  communityClaimNewIssueUrl,
  communityClaimsIssuesUrl,
  docsClaimsBrowseUrl,
  docsGithubFetchEnabled
} from '../dev/githubDocs'
import {
  SUGGESTION_CATEGORIES,
  submitClientSuggestion,
  type SuggestionCategory
} from '../dev/submitSuggestion'
import { identityFromAvatarProfile, shortenAddress } from '../../avatar/displayName'
import { resolveRouteTarget } from '../../dcl/content/route'
import type { SessionIdentity } from '../../network/SessionIdentity'
import {
  ALL_INTEGRATION_ENTRIES,
  countIntegrationByStatus,
  INTEGRATION_CATEGORIES,
  INTEGRATION_STATUS_LABEL,
  type IntegrationEntry
} from '../dev/integrationRegistry'
import {
  loadProgressMarkdown,
  parseProgressIntroLines,
  progressBrowseUrl,
  progressMdUrl,
  stripProgressIntro,
  type ProgressLoadResult
} from '../dev/progressRegistry'
import { renderInlineMarkdown, renderMarkdownToHtml } from '../dev/renderMarkdown'

type DevTab = 'community' | 'status' | 'progress'

export type DevProgressPanelOptions = {
  getSession?: () => SessionIdentity | null
}

/** Dev overlay — community workflow + full parity matrix + PROGRESS.md milestones. */
export class DevProgressPanel {
  readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private readonly panel: HTMLElement
  private readonly summaryEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly tabCommunity: HTMLButtonElement
  private readonly tabStatus: HTMLButtonElement
  private readonly tabProgress: HTMLButtonElement
  private readonly footerEl: HTMLElement
  private readonly metaEl: HTMLElement
  private activeTab: DevTab = 'community'
  private visible = false
  private claimsLoad: ClaimsLoadResult | null = null
  private progressLoad: ProgressLoadResult | null = null
  private claimsLoading = false
  private progressLoading = false
  private suggestionSubmitting = false
  private suggestionFormOpen = false
  private readonly getSession: () => SessionIdentity | null

  constructor(options: DevProgressPanelOptions = {}) {
    this.getSession = options.getSession ?? (() => null)
    this.root = document.createElement('div')
    this.root.className = 'dev-progress'
    this.root.hidden = true

    this.backdrop = document.createElement('div')
    this.backdrop.className = 'dev-progress__backdrop'

    this.panel = document.createElement('div')
    this.panel.className = 'dev-progress__panel'
    this.panel.setAttribute('role', 'dialog')
    this.panel.setAttribute('aria-modal', 'true')
    this.panel.setAttribute('aria-label', 'Development progress')

    this.panel.innerHTML = `
      <header class="dev-progress__header">
        <div class="dev-progress__title-block">
          <h2 class="dev-progress__title">Three.js Client — Dev Progress</h2>
          <p class="dev-progress__subtitle"></p>
        </div>
        <div class="dev-progress__header-actions">
          <button type="button" class="dev-progress__header-suggest" data-suggest-toggle>💡 Suggest</button>
          <button type="button" class="dev-progress__close" aria-label="Close">&times;</button>
        </div>
      </header>
      <div class="dev-progress__meta"></div>
      <nav class="dev-progress__tabs" role="tablist">
        <button type="button" class="dev-progress__tab is-active" data-tab="community" role="tab">Community</button>
        <button type="button" class="dev-progress__tab" data-tab="status" role="tab">Full status</button>
        <button type="button" class="dev-progress__tab" data-tab="progress" role="tab">Shipped</button>
      </nav>
      <div class="dev-progress__summary"></div>
      <div class="dev-progress__body"></div>
      <footer class="dev-progress__footer">
        <span class="dev-progress__legend">⬜ gap · 🟡 partial/stub · 🟢 done · 🔵 client-only</span>
      </footer>
    `

    this.summaryEl = this.panel.querySelector('.dev-progress__summary')!
    this.bodyEl = this.panel.querySelector('.dev-progress__body')!
    this.tabCommunity = this.panel.querySelector('[data-tab="community"]')!
    this.tabStatus = this.panel.querySelector('[data-tab="status"]')!
    this.tabProgress = this.panel.querySelector('[data-tab="progress"]')!
    this.footerEl = this.panel.querySelector('.dev-progress__footer')!

    const subtitle = this.panel.querySelector('.dev-progress__subtitle')!
    subtitle.textContent = 'Community workflow from github.com/lastraum/dcl-threejs-client'

    this.metaEl = this.panel.querySelector('.dev-progress__meta')!
    this.metaEl.hidden = true

    this.root.appendChild(this.backdrop)
    this.root.appendChild(this.panel)
    document.body.appendChild(this.root)

    this.panel.querySelector('.dev-progress__close')!.addEventListener('click', () => this.hide())
    this.panel.querySelector('[data-suggest-toggle]')!.addEventListener('click', () => this.openSuggestionForm())
    this.backdrop.addEventListener('click', () => this.hide())
    this.tabCommunity.addEventListener('click', () => this.setTab('community'))
    this.tabStatus.addEventListener('click', () => this.setTab('status'))
    this.tabProgress.addEventListener('click', () => this.setTab('progress'))
    window.addEventListener('keydown', this.onKeyDown)

    void this.refreshClaims()
    void this.refreshProgress()
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.root.remove()
  }

  isVisible(): boolean {
    return this.visible
  }

  show(): void {
    this.visible = true
    this.root.hidden = false
    requestAnimationFrame(() => this.root.classList.add('is-open'))
    void this.refreshClaims(true)
    void this.refreshProgress(true)
    this.render()
  }

  /** Open panel on a tab (e.g. What's new → Shipped). */
  showTab(tab: DevTab): void {
    this.setTab(tab)
    this.show()
  }

  hide(): void {
    this.visible = false
    this.root.classList.remove('is-open')
    window.setTimeout(() => {
      if (!this.visible) this.root.hidden = true
    }, 200)
  }

  toggle(): boolean {
    if (this.visible) {
      this.hide()
      return false
    }
    this.show()
    return true
  }

  private async refreshClaims(force = false): Promise<void> {
    if (this.claimsLoading) return
    this.claimsLoading = true
    try {
      this.claimsLoad = await loadClaimsRegistry(force)
      if (this.visible && this.activeTab === 'community') this.renderCommunity()
    } finally {
      this.claimsLoading = false
    }
  }

  private async refreshProgress(force = false): Promise<void> {
    if (this.progressLoading) return
    this.progressLoading = true
    try {
      this.progressLoad = await loadProgressMarkdown(force)
      if (this.visible && (this.activeTab === 'community' || this.activeTab === 'progress')) this.render()
    } finally {
      this.progressLoading = false
    }
  }

  private setTab(tab: DevTab): void {
    this.activeTab = tab
    this.tabCommunity.classList.toggle('is-active', tab === 'community')
    this.tabStatus.classList.toggle('is-active', tab === 'status')
    this.tabProgress.classList.toggle('is-active', tab === 'progress')
    this.render()
  }

  private render(): void {
    if (this.activeTab === 'community') {
      this.renderCommunity()
    } else if (this.activeTab === 'status') {
      this.renderIntegrationStatus()
    } else {
      this.renderProgress()
    }
  }

  private countWorkflowStage(workflow: WorkflowItem[], stage: WorkflowStage): number {
    return workflow.filter((row) => row.stage === stage).length
  }

  private renderCommunity(): void {
    const workflow = this.claimsLoad?.registry.workflow ?? []
    const inProgress = this.countWorkflowStage(workflow, 'in_progress')
    const pending = this.countWorkflowStage(workflow, 'pending_review')
    const merged = this.countWorkflowStage(workflow, 'merged')

    this.summaryEl.innerHTML = `
      <span class="dev-progress__chip dev-progress__chip--progress">🟡 ${inProgress} in progress</span>
      <span class="dev-progress__chip dev-progress__chip--pending">🟠 ${pending} pending review</span>
      <span class="dev-progress__chip dev-progress__chip--done">🟢 ${merged} merged</span>
      <a class="dev-progress__chip dev-progress__chip--claim" href="${escapeHtml(communityClaimNewIssueUrl())}" target="_blank" rel="noopener">+ Claim work</a>
    `

    const branch = this.claimsLoad?.branch ?? this.progressLoad?.branch ?? 'dev-latest'
    const baseBranch = this.claimsLoad?.registry.base_branch ?? 'dev-latest'
    const claimsLive = this.claimsLoad?.source === 'github'
    const prsUrl = `https://github.com/lastraum/dcl-threejs-client/pulls?q=is%3Aopen+base%3A${encodeURIComponent(baseBranch)}`
    this.footerEl.innerHTML = `<span class="dev-progress__legend">${
      claimsLive ? 'Live claims from GitHub' : 'Claims offline (empty placeholder — not live workflow)'
    } · docs <code>${escapeHtml(branch)}</code> · PRs → <code>${escapeHtml(baseBranch)}</code> · <a href="${escapeHtml(communityClaimsIssuesUrl())}" target="_blank" rel="noopener">claims</a> · <a href="${escapeHtml(prsUrl)}" target="_blank" rel="noopener">open PRs</a> · <a href="${escapeHtml(docsClaimsBrowseUrl(branch))}" target="_blank" rel="noopener">CLAIMS.yaml</a></span>`

    this.bodyEl.innerHTML = ''

    const intro = this.buildProgressIntroSection()
    if (intro) this.bodyEl.appendChild(intro)

    const suggestionSection = this.buildSuggestionSection()
    this.bodyEl.appendChild(suggestionSection)
    if (this.suggestionFormOpen) {
      requestAnimationFrame(() => {
        suggestionSection.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
        suggestionSection.querySelector<HTMLInputElement>('input[name="summary"]')?.focus()
      })
    }

    if (!this.claimsLoad) {
      const loading = document.createElement('p')
      loading.className = 'dev-progress__loading'
      loading.textContent = docsGithubFetchEnabled()
        ? 'Fetching community workflow from GitHub…'
        : 'Loading workflow (offline snapshot)…'
      this.bodyEl.appendChild(loading)
      return
    }

    this.bodyEl.appendChild(this.buildWorkflowTable(workflow))
  }

  private renderIntegrationStatus(): void {
    const counts = countIntegrationByStatus(ALL_INTEGRATION_ENTRIES)
    const covered = counts.render + counts.stub + counts.partial + counts['client-only']
    this.summaryEl.innerHTML = `
      <span class="dev-progress__chip dev-progress__chip--done">🟢 ${counts.render} done</span>
      <span class="dev-progress__chip dev-progress__chip--progress">🟡 ${counts.stub + counts.partial} partial</span>
      <span class="dev-progress__chip dev-progress__chip--client">🔵 ${counts['client-only']} client</span>
      <span class="dev-progress__chip dev-progress__chip--next">⬜ ${counts.none} not started</span>
      <span class="dev-progress__chip">${covered} / ${ALL_INTEGRATION_ENTRIES.length} tracked</span>
    `
    this.footerEl.innerHTML =
      '<span class="dev-progress__legend">Source: integrationRegistry.ts · docs/INTEGRATION.md</span>'

    this.bodyEl.innerHTML = ''
    for (const category of INTEGRATION_CATEGORIES) {
      if (category.description) {
        const intro = document.createElement('p')
        intro.className = 'dev-progress__registry-meta'
        intro.textContent = category.description
        this.bodyEl.appendChild(intro)
      }
      this.bodyEl.appendChild(this.buildIntegrationTable(category.title, category.entries))
    }
  }

  private renderProgress(): void {
    if (!this.progressLoad) {
      this.summaryEl.innerHTML = '<span class="dev-progress__chip">Loading progress…</span>'
      this.bodyEl.innerHTML = docsGithubFetchEnabled()
        ? '<p class="dev-progress__loading">Fetching docs/PROGRESS.md from GitHub…</p>'
        : '<p class="dev-progress__loading">Loading progress (offline snapshot)…</p>'
      return
    }

    const { markdown, source, branch } = this.progressLoad
    // Version = this build (package.json). Progress body = live GitHub PROGRESS.md when source=github.
    this.summaryEl.innerHTML = `
      <span class="dev-progress__chip dev-progress__chip--done" title="From package.json">client ${escapeHtml(APP_VERSION)}</span>
      <span class="dev-progress__chip ${source === 'github' ? 'dev-progress__chip--done' : 'dev-progress__chip--pending'}" title="Milestone log source">
        ${source === 'github' ? `live progress @ ${escapeHtml(branch)}` : 'progress offline (not live)'}
      </span>
    `
    this.footerEl.innerHTML = `<span class="dev-progress__legend">${
      source === 'github'
        ? `Live from GitHub · <code>${escapeHtml(branch)}</code>`
        : 'Could not load live docs — offline notice only (not a progress snapshot)'
    } · <a href="${escapeHtml(progressBrowseUrl(branch))}" target="_blank" rel="noopener">PROGRESS.md</a> · <a href="${escapeHtml(progressMdUrl(branch))}" target="_blank" rel="noopener">raw</a></span>`

    this.bodyEl.innerHTML = ''
    if (source !== 'github') {
      const banner = document.createElement('p')
      banner.className = 'dev-progress__registry-meta'
      banner.textContent =
        'Client version is from package.json. Milestone notes load live from GitHub — this offline path is not the project progress log.'
      this.bodyEl.appendChild(banner)
    }
    const article = document.createElement('article')
    article.className = 'dev-progress__markdown'
    article.innerHTML = renderMarkdownToHtml(
      source === 'github' ? stripProgressIntro(markdown) : markdown
    )
    this.bodyEl.appendChild(article)
  }

  private openSuggestionForm(): void {
    this.suggestionFormOpen = true
    if (this.activeTab !== 'community') this.setTab('community')
    else this.renderCommunity()
  }

  private resolveSuggestionAuthor(): string | undefined {
    const session = this.getSession()
    if (!session) return undefined
    const address = session.getAddress()
    const profile = session.getProfile()
    if (profile) {
      const identity = identityFromAvatarProfile(profile, address)
      if (address) return `${identity.displayName} (${address})`
      return identity.displayName
    }
    if (address) return shortenAddress(address)
    return undefined
  }

  private suggestionAuthorLabel(): string {
    const session = this.getSession()
    if (!session?.getAddress()) return 'Guest'
    const profile = session.getProfile()
    if (profile?.displayName?.trim()) return profile.displayName.trim()
    const address = session.getAddress()
    return address ? shortenAddress(address) : 'Guest'
  }

  private formatRouteContext(): string | undefined {
    const route = resolveRouteTarget()
    if (route.kind === 'coords') return `${route.x},${route.y}`
    if (route.kind === 'world') return route.worldName
    if (route.kind === 'map') return 'map'
    if (route.kind === 'events') return 'events'
    if (route.kind === 'communities') return 'communities'
    if (route.kind === 'profile') return 'profile'
    if (route.kind === 'editor') return 'editor'
    return undefined
  }

  private buildSuggestionSection(): HTMLElement {
    const section = document.createElement('section')
    section.className = 'dev-progress__section dev-progress__suggest'
    if (!this.suggestionFormOpen) section.hidden = true
    const authorLabel = this.suggestionAuthorLabel()
    section.innerHTML = `
      <h3 class="dev-progress__section-title">Suggest an improvement</h3>
      <p class="dev-progress__suggest-hint">
        Submits in-app → GitHub issue labeled <code>suggestion</code>.
        Submitting as <strong>${escapeHtml(authorLabel)}</strong>.
      </p>
      <form class="dev-progress__suggest-form">
        <label class="dev-progress__suggest-field">
          <span>Summary</span>
          <input type="text" name="summary" maxlength="120" required placeholder="One-line idea" />
        </label>
        <label class="dev-progress__suggest-field">
          <span>Category</span>
          <select name="category" required>
            ${SUGGESTION_CATEGORIES.map(
              (c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`
            ).join('')}
          </select>
        </label>
        <label class="dev-progress__suggest-field dev-progress__suggest-field--wide">
          <span>Details</span>
          <textarea name="details" rows="4" maxlength="8000" required placeholder="What you tried, expected behavior, or mockup notes"></textarea>
        </label>
        <div class="dev-progress__suggest-actions">
          <button type="submit" class="dev-progress__suggest-submit">Submit suggestion</button>
          <span class="dev-progress__suggest-status" hidden></span>
        </div>
      </form>
    `

    const form = section.querySelector('form')!
    const statusEl = section.querySelector('.dev-progress__suggest-status') as HTMLElement
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.submitSuggestionForm(form, statusEl)
    })
    return section
  }

  private async submitSuggestionForm(
    form: HTMLFormElement,
    statusEl: HTMLElement
  ): Promise<void> {
    if (this.suggestionSubmitting) return
    const data = new FormData(form)
    const summary = String(data.get('summary') ?? '').trim()
    const details = String(data.get('details') ?? '').trim()
    const category = String(data.get('category') ?? 'Other') as SuggestionCategory

    if (summary.length < 4 || details.length < 10) {
      statusEl.hidden = false
      statusEl.textContent = 'Summary (4+) and details (10+) required.'
      statusEl.className = 'dev-progress__suggest-status dev-progress__suggest-status--error'
      return
    }

    this.suggestionSubmitting = true
    const submitBtn = form.querySelector('.dev-progress__suggest-submit') as HTMLButtonElement
    submitBtn.disabled = true
    statusEl.hidden = false
    statusEl.className = 'dev-progress__suggest-status'
    statusEl.textContent = 'Sending…'

    const result = await submitClientSuggestion({
      summary,
      category,
      details,
      author: this.resolveSuggestionAuthor(),
      route: this.formatRouteContext()
    })

    this.suggestionSubmitting = false
    submitBtn.disabled = false

    if (result.ok) {
      statusEl.className = 'dev-progress__suggest-status dev-progress__suggest-status--ok'
      if (result.issueUrl) {
        const label = result.issueNumber ? `#${result.issueNumber}` : 'issue'
        statusEl.innerHTML = `Created <a href="${escapeHtml(result.issueUrl)}" target="_blank" rel="noopener">${escapeHtml(label)}</a> with label <code>suggestion</code>.`
      } else {
        statusEl.textContent = 'Sent — your suggestion issue is being filed now.'
      }
      form.reset()
      return
    }

    statusEl.className = 'dev-progress__suggest-status dev-progress__suggest-status--error'
    statusEl.textContent = result.error || 'Submit failed'
  }

  private buildProgressIntroSection(): HTMLElement | null {
    if (!this.progressLoad) {
      const loading = document.createElement('section')
      loading.className = 'dev-progress__intro dev-progress__intro--loading'
      loading.textContent = docsGithubFetchEnabled()
        ? 'Loading project status from GitHub…'
        : 'Loading project status…'
      return loading
    }

    const lines = parseProgressIntroLines(this.progressLoad.markdown)
    if (!lines.length) return null

    const section = document.createElement('section')
    section.className = 'dev-progress__intro'
    section.setAttribute('aria-label', 'Project status')
    for (const line of lines) {
      const row = document.createElement('p')
      row.className = 'dev-progress__intro-line'
      row.innerHTML = renderInlineMarkdown(line)
      section.appendChild(row)
    }
    return section
  }

  private buildWorkflowTable(workflow: WorkflowItem[]): HTMLElement {
    const section = document.createElement('section')
    section.className = 'dev-progress__section'
    section.innerHTML = `<h3 class="dev-progress__section-title">Community workflow</h3>`

    const sorted = [...workflow].sort((a, b) => {
      const stageDiff =
        WORKFLOW_STAGE_ORDER.indexOf(a.stage) - WORKFLOW_STAGE_ORDER.indexOf(b.stage)
      if (stageDiff !== 0) return stageDiff
      return (b.updated ?? '').localeCompare(a.updated ?? '')
    })

    const table = document.createElement('table')
    table.className = 'dev-progress__table dev-progress__table--workflow'
    table.innerHTML = `
      <thead>
        <tr>
          <th>Stage</th>
          <th>Area</th>
          <th>Work</th>
          <th>Owner</th>
          <th>Updated</th>
          <th>Links</th>
        </tr>
      </thead>
    `
    const tbody = document.createElement('tbody')

    if (!sorted.length) {
      const tr = document.createElement('tr')
      tr.innerHTML = `<td colspan="6" class="dev-progress__empty">No workflow rows synced yet.</td>`
      tbody.appendChild(tr)
    }

    for (const row of sorted) {
      const tr = document.createElement('tr')
      tr.className = `dev-progress__row dev-progress__row--workflow-${row.stage.replace('_', '-')}`
      tr.innerHTML = `
        <td class="dev-progress__status">${WORKFLOW_STAGE_LABEL[row.stage]}</td>
        <td><code>${escapeHtml(row.integration_ref)}</code></td>
        <td class="dev-progress__name">${escapeHtml(row.title)}</td>
        <td>${escapeHtml(row.owner)}</td>
        <td>${escapeHtml(row.updated ?? '—')}</td>
        <td>${this.workflowLinks(row)}</td>
      `
      tbody.appendChild(tr)
    }

    table.appendChild(tbody)
    section.appendChild(table)
    return section
  }

  private workflowLinks(row: WorkflowItem): string {
    const parts: string[] = []
    if (row.issue_url && row.issue) {
      parts.push(
        `<a href="${escapeHtml(row.issue_url)}" target="_blank" rel="noopener">#${row.issue}</a>`
      )
    }
    if (row.pr_url && row.pr) {
      parts.push(
        `<a href="${escapeHtml(row.pr_url)}" target="_blank" rel="noopener">PR #${row.pr}</a>`
      )
    }
    return parts.length ? parts.join(' · ') : '—'
  }

  private buildIntegrationTable(title: string, items: IntegrationEntry[]): HTMLElement {
    const section = document.createElement('section')
    section.className = 'dev-progress__section'
    section.innerHTML = `<h3 class="dev-progress__section-title">${escapeHtml(title)}</h3>`

    const table = document.createElement('table')
    table.className = 'dev-progress__table dev-progress__table--ecs'
    table.innerHTML = `
      <thead>
        <tr>
          <th>Status</th>
          <th>Name</th>
          <th>Ref</th>
          <th>Phase</th>
          <th>Notes</th>
        </tr>
      </thead>
    `
    const tbody = document.createElement('tbody')
    for (const item of items) {
      const tr = document.createElement('tr')
      tr.className = `dev-progress__row dev-progress__row--ecs-${item.status}`
      tr.innerHTML = `
        <td class="dev-progress__status">${INTEGRATION_STATUS_LABEL[item.status]}</td>
        <td class="dev-progress__name">${escapeHtml(item.name)}</td>
        <td><code>${escapeHtml(item.id)}</code></td>
        <td>${item.phase ?? '—'}</td>
        <td class="dev-progress__notes">${escapeHtml(item.notes ?? '')}</td>
      `
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    section.appendChild(table)
    return section
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (!this.visible) return
    if (ev.key === 'Escape') {
      ev.preventDefault()
      this.hide()
    }
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}