import { APP_VERSION } from '../appVersion'
import {
  CLAIM_STATUS_LABEL,
  loadClaimsRegistry,
  type ClaimsLoadResult,
  type CommunityClaim
} from '../dev/claimsRegistry'
import {
  communityClaimNewIssueUrl,
  communityClaimsIssuesUrl,
  docsClaimsBrowseUrl,
  docsGithubFetchEnabled
} from '../dev/githubDocs'
import {
  ALL_INTEGRATION_ENTRIES,
  countIntegrationByStatus,
  INTEGRATION_CATEGORIES,
  INTEGRATION_STATUS_LABEL,
  PARITY_GAP_STATUSES,
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

/** Dev overlay — parity gaps + community claims (GitHub issues) + PROGRESS.md from GitHub. */
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

  constructor() {
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
        <button type="button" class="dev-progress__close" aria-label="Close">&times;</button>
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
    subtitle.textContent = 'Parity gaps + community claims from github.com/lastraum/dcl-threejs-client'

    this.metaEl = this.panel.querySelector('.dev-progress__meta')!
    this.metaEl.hidden = true

    this.root.appendChild(this.backdrop)
    this.root.appendChild(this.panel)
    document.body.appendChild(this.root)

    this.panel.querySelector('.dev-progress__close')!.addEventListener('click', () => this.hide())
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

  private renderCommunity(): void {
    const integrationCounts = countIntegrationByStatus(ALL_INTEGRATION_ENTRIES)
    const gapCount =
      integrationCounts.none + integrationCounts.stub + integrationCounts.partial
    const claimCount = this.claimsLoad?.registry.claims.length ?? 0

    this.summaryEl.innerHTML = `
      <span class="dev-progress__chip dev-progress__chip--next">⬜ ${gapCount} parity gaps</span>
      <span class="dev-progress__chip dev-progress__chip--progress">🟡 ${claimCount} being worked on</span>
      <span class="dev-progress__chip dev-progress__chip--done">🟢 ${integrationCounts.render} shipped</span>
      <a class="dev-progress__chip dev-progress__chip--claim" href="${escapeHtml(communityClaimNewIssueUrl())}" target="_blank" rel="noopener">+ Claim work</a>
    `

    const branch = this.claimsLoad?.branch ?? this.progressLoad?.branch ?? 'dev-latest'
    const sourceLabel =
      this.claimsLoad?.source === 'github' || this.progressLoad?.source === 'github'
        ? 'GitHub'
        : 'offline snapshot'
    this.footerEl.innerHTML = `<span class="dev-progress__legend">${sourceLabel} · branch <code>${escapeHtml(branch)}</code> · <a href="${escapeHtml(communityClaimsIssuesUrl())}" target="_blank" rel="noopener">in-progress issues</a> · <a href="${escapeHtml(docsClaimsBrowseUrl(branch))}" target="_blank" rel="noopener">CLAIMS.yaml</a></span>`

    this.bodyEl.innerHTML = ''

    const intro = this.buildProgressIntroSection()
    if (intro) this.bodyEl.appendChild(intro)

    if (!this.claimsLoad) {
      const loading = document.createElement('p')
      loading.className = 'dev-progress__loading'
      loading.textContent = docsGithubFetchEnabled()
        ? 'Fetching community claims from GitHub…'
        : 'Loading claims (offline snapshot)…'
      this.bodyEl.appendChild(loading)
    } else {
      const claimsSection = this.buildClaimsSection(this.claimsLoad.registry.claims)
      if (claimsSection) this.bodyEl.appendChild(claimsSection)
    }

    for (const category of INTEGRATION_CATEGORIES) {
      const gaps = category.entries.filter((e) => PARITY_GAP_STATUSES.includes(e.status))
      if (!gaps.length) continue
      this.bodyEl.appendChild(this.buildIntegrationTable(`Parity gaps — ${category.title}`, gaps))
    }
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
    const sourceLabel = source === 'github' ? 'GitHub' : 'offline snapshot'
    this.summaryEl.innerHTML = `
      <span class="dev-progress__chip dev-progress__chip--done">v${escapeHtml(APP_VERSION)} client</span>
    `
    this.footerEl.innerHTML = `<span class="dev-progress__legend">${sourceLabel} · branch <code>${escapeHtml(branch)}</code> · <a href="${escapeHtml(progressBrowseUrl(branch))}" target="_blank" rel="noopener">PROGRESS.md</a> · <a href="${escapeHtml(progressMdUrl(branch))}" target="_blank" rel="noopener">raw</a></span>`

    this.bodyEl.innerHTML = ''
    const article = document.createElement('article')
    article.className = 'dev-progress__markdown'
    article.innerHTML = renderMarkdownToHtml(stripProgressIntro(markdown))
    this.bodyEl.appendChild(article)
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

  private buildClaimsSection(claims: CommunityClaim[]): HTMLElement | null {
    if (!claims.length) return null

    const section = document.createElement('section')
    section.className = 'dev-progress__section'
    section.innerHTML = `<h3 class="dev-progress__section-title">Merges under review</h3>`

    const table = document.createElement('table')
    table.className = 'dev-progress__table'
    table.innerHTML = `
      <thead>
        <tr>
          <th>Status</th>
          <th>Area</th>
          <th>Owner</th>
          <th>Issue</th>
        </tr>
      </thead>
    `
    const tbody = document.createElement('tbody')
    for (const claim of claims) {
      const tr = document.createElement('tr')
      tr.className = `dev-progress__row dev-progress__row--${claim.status.replace('_', '-')}`
      const issueLink = claim.issue_url
        ? `<a href="${escapeHtml(claim.issue_url)}" target="_blank" rel="noopener">#${claim.issue}</a>`
        : `#${claim.issue}`
      tr.innerHTML = `
        <td class="dev-progress__status">${CLAIM_STATUS_LABEL[claim.status]}</td>
        <td class="dev-progress__name"><code>${escapeHtml(claim.integration_ref)}</code><br>${escapeHtml(claim.title)}</td>
        <td>${escapeHtml(claim.owner)}</td>
        <td>${issueLink}</td>
      `
      tbody.appendChild(tr)
    }
    table.appendChild(tbody)
    section.appendChild(table)
    return section
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