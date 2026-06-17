import {
  countChangelogEntries,
  DEV_CHANGELOG,
  DEV_PROGRESS_META,
  type ChangelogEntry
} from '../dev/progressData'
import {
  ALL_INTEGRATION_ENTRIES,
  countIntegrationByStatus,
  INTEGRATION_CATEGORIES,
  INTEGRATION_STATUS_LABEL,
  type IntegrationEntry
} from '../dev/integrationRegistry'
import {
  countTasksByStatus,
  loadTasksRegistry,
  tasksGithubFetchEnabled,
  ROADMAP_GROUPS,
  TASK_STATUS_LABEL,
  tasksYamlUrl,
  type RegistryTask,
  type TasksLoadResult
} from '../dev/tasksRegistry'

type DevTab = 'roadmap' | 'status' | 'changelog'

/** Centered dev overlay — roadmap (TASKS.yaml) + ECS table + version changelog. */
export class DevProgressPanel {
  readonly root: HTMLElement
  private readonly backdrop: HTMLElement
  private readonly panel: HTMLElement
  private readonly summaryEl: HTMLElement
  private readonly bodyEl: HTMLElement
  private readonly tabRoadmap: HTMLButtonElement
  private readonly tabStatus: HTMLButtonElement
  private readonly tabChangelog: HTMLButtonElement
  private readonly footerEl: HTMLElement
  private activeTab: DevTab = 'roadmap'
  private visible = false
  private tasksLoad: TasksLoadResult | null = null
  private tasksLoading = false

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
        <button type="button" class="dev-progress__tab is-active" data-tab="roadmap" role="tab">Roadmap</button>
        <button type="button" class="dev-progress__tab" data-tab="status" role="tab">Integration status</button>
        <button type="button" class="dev-progress__tab" data-tab="changelog" role="tab">Version</button>
      </nav>
      <div class="dev-progress__summary"></div>
      <div class="dev-progress__body"></div>
      <footer class="dev-progress__footer">
        <span class="dev-progress__legend">⬜ not started · 🟡 partial · 🟢 done · 🔵 client-only</span>
      </footer>
    `

    this.summaryEl = this.panel.querySelector('.dev-progress__summary')!
    this.bodyEl = this.panel.querySelector('.dev-progress__body')!
    this.tabRoadmap = this.panel.querySelector('[data-tab="roadmap"]')!
    this.tabStatus = this.panel.querySelector('[data-tab="status"]')!
    this.tabChangelog = this.panel.querySelector('[data-tab="changelog"]')!
    this.footerEl = this.panel.querySelector('.dev-progress__footer')!

    const subtitle = this.panel.querySelector('.dev-progress__subtitle')!
    subtitle.textContent = DEV_PROGRESS_META.tagline

    const meta = this.panel.querySelector('.dev-progress__meta')!
    meta.innerHTML = `
      <span>Phase: <strong>${DEV_PROGRESS_META.phase}</strong></span>
      <span>v${DEV_PROGRESS_META.version}</span>
      <span>Updated ${DEV_PROGRESS_META.lastUpdated}</span>
    `

    this.root.appendChild(this.backdrop)
    this.root.appendChild(this.panel)
    document.body.appendChild(this.root)

    this.panel.querySelector('.dev-progress__close')!.addEventListener('click', () => this.hide())
    this.backdrop.addEventListener('click', () => this.hide())
    this.tabRoadmap.addEventListener('click', () => this.setTab('roadmap'))
    this.tabStatus.addEventListener('click', () => this.setTab('status'))
    this.tabChangelog.addEventListener('click', () => this.setTab('changelog'))
    window.addEventListener('keydown', this.onKeyDown)

    void this.refreshTasks()
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
    void this.refreshTasks(true)
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

  private async refreshTasks(force = false): Promise<void> {
    if (this.tasksLoading) return
    this.tasksLoading = true
    try {
      this.tasksLoad = await loadTasksRegistry(force)
      if (this.visible && this.activeTab === 'roadmap') this.renderRoadmap()
    } finally {
      this.tasksLoading = false
    }
  }

  private setTab(tab: DevTab): void {
    this.activeTab = tab
    this.tabRoadmap.classList.toggle('is-active', tab === 'roadmap')
    this.tabStatus.classList.toggle('is-active', tab === 'status')
    this.tabChangelog.classList.toggle('is-active', tab === 'changelog')
    this.render()
  }

  private render(): void {
    if (this.activeTab === 'roadmap') {
      this.renderRoadmap()
    } else if (this.activeTab === 'status') {
      this.renderIntegrationStatus()
    } else {
      this.renderChangelog()
    }
  }

  private renderRoadmap(): void {
    if (!this.tasksLoad) {
      this.summaryEl.innerHTML = '<span class="dev-progress__chip">Loading tasks…</span>'
      this.bodyEl.innerHTML = tasksGithubFetchEnabled()
        ? '<p class="dev-progress__loading">Fetching docs/TASKS.yaml from GitHub…</p>'
        : '<p class="dev-progress__loading">Loading task backlog (offline snapshot)…</p>'
      return
    }

    const { registry, source, branch } = this.tasksLoad
    const tasks = registry.tasks
    const counts = countTasksByStatus(tasks)
    const sourceLabel = source === 'github' ? 'GitHub' : 'offline snapshot'
    this.summaryEl.innerHTML = `
      <span class="dev-progress__chip dev-progress__chip--done">🟢 ${counts.done} done</span>
      <span class="dev-progress__chip dev-progress__chip--progress">🟡 ${counts.in_progress + counts.partial} active</span>
      <span class="dev-progress__chip dev-progress__chip--next">⬜ ${counts.open} open</span>
      <span class="dev-progress__chip dev-progress__chip--blocked">🔴 ${counts.blocked} blocked</span>
    `
    this.footerEl.innerHTML = `<span class="dev-progress__legend">${sourceLabel} · branch <code>${escapeHtml(branch)}</code> · <a href="${escapeHtml(tasksYamlUrl(branch))}" target="_blank" rel="noopener">TASKS.yaml</a></span>`

    this.bodyEl.innerHTML = ''
    if (registry.updated) {
      const updated = document.createElement('p')
      updated.className = 'dev-progress__registry-meta'
      updated.textContent = `Registry updated ${registry.updated} · ${tasks.length} tasks`
      this.bodyEl.appendChild(updated)
    }

    for (const group of ROADMAP_GROUPS) {
      const items = tasks.filter((t) => group.statuses.includes(t.status))
      if (!items.length) continue
      this.bodyEl.appendChild(this.buildTaskTable(group.title, items))
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
      '<span class="dev-progress__legend">Source: integrationRegistry.ts · docs/INTEGRATION_STATUS.md</span>'

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

  private renderChangelog(): void {
    const stats = countChangelogEntries(DEV_CHANGELOG)
    this.summaryEl.innerHTML = `
      <span class="dev-progress__chip dev-progress__chip--done">v${escapeHtml(DEV_PROGRESS_META.version)} current</span>
      <span class="dev-progress__chip">${stats.releases} release${stats.releases === 1 ? '' : 's'}</span>
      <span class="dev-progress__chip">${stats.items} shipped items</span>
      <span class="dev-progress__chip">Updated ${escapeHtml(stats.latestDate)}</span>
    `
    this.footerEl.innerHTML =
      '<span class="dev-progress__legend">Changelog in <code>progressData.ts</code> · tasks in <code>docs/TASKS.yaml</code></span>'

    this.bodyEl.innerHTML = ''
    for (const entry of DEV_CHANGELOG) {
      this.bodyEl.appendChild(this.buildChangelogEntry(entry))
    }
  }

  private buildChangelogEntry(entry: ChangelogEntry): HTMLElement {
    const section = document.createElement('section')
    section.className = 'dev-progress__section dev-progress__changelog'
    const titleSuffix = entry.title ? ` — ${escapeHtml(entry.title)}` : ''
    section.innerHTML = `
      <div class="dev-progress__changelog-header">
        <h3 class="dev-progress__section-title dev-progress__changelog-version">v${escapeHtml(entry.version)}${titleSuffix}</h3>
        <span class="dev-progress__changelog-date">${escapeHtml(entry.date)}</span>
      </div>
    `

    const list = document.createElement('ul')
    list.className = 'dev-progress__changelog-list'
    for (const item of entry.items) {
      const li = document.createElement('li')
      li.textContent = item
      list.appendChild(li)
    }
    section.appendChild(list)
    return section
  }

  private buildTaskTable(title: string, items: RegistryTask[]): HTMLElement {
    const section = document.createElement('section')
    section.className = 'dev-progress__section'
    section.innerHTML = `<h3 class="dev-progress__section-title">${title}</h3>`

    const table = document.createElement('table')
    table.className = 'dev-progress__table'
    table.innerHTML = `
      <thead>
        <tr>
          <th>Status</th>
          <th>Task</th>
          <th>Track</th>
          <th>Phase</th>
          <th>Owner</th>
          <th>Notes</th>
        </tr>
      </thead>
    `
    const tbody = document.createElement('tbody')
    for (const item of items) {
      const tr = document.createElement('tr')
      tr.className = `dev-progress__row dev-progress__row--${item.status.replace('_', '-')}`
      const owner = item.owner ?? '—'
      const notes = [item.notes, item.priority ? `P: ${item.priority}` : ''].filter(Boolean).join(' · ')
      tr.innerHTML = `
        <td class="dev-progress__status">${TASK_STATUS_LABEL[item.status]}</td>
        <td class="dev-progress__name"><code>${escapeHtml(item.id)}</code><br>${escapeHtml(item.title)}</td>
        <td>${escapeHtml(item.track ?? '—')}</td>
        <td>${item.phase ?? '—'}</td>
        <td>${escapeHtml(owner)}</td>
        <td class="dev-progress__notes">${escapeHtml(notes)}</td>
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
