import {
  connectProjectFolder,
  getDevBridgeStatus,
  isCreatorHubScenesLinked,
  listProjects,
  relinkProject,
  removeProject,
  rescanCreatorHubScenes,
  syncDevBridgeProjects,
  type LocalProjectRecord
} from '../localProjects/projectStore'

export type EditorHubPageCallbacks = {
  onOpenProject: (projectId: string) => void
}

export class EditorHubPage {
  private root: HTMLDivElement
  private grid: HTMLDivElement
  private errorEl: HTMLDivElement
  private statusEl: HTMLDivElement
  private devBridgeAvailable = false

  constructor(
    container: HTMLElement,
    private callbacks: EditorHubPageCallbacks
  ) {
    this.root = document.createElement('div')
    this.root.className = 'editor-hub'
    container.appendChild(this.root)

    const header = document.createElement('header')
    header.className = 'editor-hub-header'
    const title = document.createElement('h1')
    title.textContent = 'Local Scenes'
    header.appendChild(title)

    const actions = document.createElement('div')
    actions.className = 'editor-hub-actions'

    const syncDevBtn = document.createElement('button')
    syncDevBtn.type = 'button'
    syncDevBtn.className = 'editor-hub-add editor-hub-add--primary'
    syncDevBtn.textContent = 'Sync Creator Hub (dev)'
    syncDevBtn.addEventListener('click', () => void this.handleSyncDevBridge())

    actions.appendChild(syncDevBtn)
    header.appendChild(actions)

    this.root.appendChild(header)

    this.errorEl = document.createElement('div')
    this.errorEl.className = 'editor-hub-error'
    this.errorEl.hidden = true
    this.root.appendChild(this.errorEl)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'editor-hub-status'
    this.statusEl.hidden = true
    this.root.appendChild(this.statusEl)

    this.grid = document.createElement('div')
    this.grid.className = 'editor-hub-grid'
    this.root.appendChild(this.grid)

    void this.bootstrap()
  }

  dispose(): void {
    this.root.remove()
  }

  private async bootstrap(): Promise<void> {
    const bridgeStatus = await getDevBridgeStatus()
    this.devBridgeAvailable = bridgeStatus.available

    if (bridgeStatus.available) {
      try {
        const result = await syncDevBridgeProjects()
        if (result && result.total > 0) {
          this.showStatus(`Synced ${result.total} Creator Hub scene(s).`)
        }
      } catch {
        /* ignore */
      }
    } else if (await isCreatorHubScenesLinked()) {
      try {
        const result = await rescanCreatorHubScenes()
        if (result && (result.imported > 0 || result.updated > 0)) {
          this.showStatus(`Creator Hub: ${result.total} scene(s) (${result.imported} new)`)
        }
      } catch {
        /* permission may need re-grant on open */
      }
    }
    await this.refresh()
  }

  async refresh(): Promise<void> {
    const projects = await listProjects()
    this.grid.innerHTML = ''
    if (projects.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'editor-hub-empty'
      empty.textContent = 'No projects yet. Click Sync Creator Hub (dev).'
      this.grid.appendChild(empty)
      return
    }
    for (const project of projects) {
      this.grid.appendChild(this.renderCard(project))
    }
  }

  private renderCard(project: LocalProjectRecord): HTMLDivElement {
    const card = document.createElement('div')
    card.className = 'editor-hub-card'
    if (project.source === 'creator-hub') {
      card.classList.add('editor-hub-card--creator-hub')
    }
    if (project.permission !== 'granted') {
      card.classList.add('editor-hub-card--pending')
    }
    if (project.accessMode === 'dev-bridge') {
      card.classList.add('editor-hub-card--dev-bridge')
    }

    const name = document.createElement('h2')
    name.textContent = project.name
    card.appendChild(name)

    const meta = document.createElement('p')
    meta.className = 'editor-hub-card-meta'
    const parcel = project.parcelCount ? `${project.parcelCount} parcel(s)` : 'Unknown size'
    const base = project.baseParcel ? ` · base ${project.baseParcel}` : ''
    const opened = new Date(project.lastOpenedAt).toLocaleString()
    const access =
      project.accessMode === 'dev-bridge' ? 'dev bridge · ' : project.source === 'creator-hub' ? 'Creator Hub · ' : ''
    const folder = project.folderName ? `${project.folderName} · ` : ''
    meta.textContent = `${access}${folder}${parcel}${base} · opened ${opened}`
    card.appendChild(meta)

    if (project.pathHint && project.permission !== 'granted') {
      const path = document.createElement('p')
      path.className = 'editor-hub-card-path'
      path.textContent = project.pathHint
      path.title = project.pathHint
      card.appendChild(path)
    }

    if (project.permission !== 'granted') {
      const warn = document.createElement('p')
      warn.className = 'editor-hub-card-warn'
      warn.textContent = 'Not connected — click Sync Creator Hub (dev)'
      card.appendChild(warn)
    }

    const actions = document.createElement('div')
    actions.className = 'editor-hub-card-actions'

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.textContent = 'Open'
    openBtn.disabled = project.permission !== 'granted'
    openBtn.addEventListener('click', () => this.callbacks.onOpenProject(project.id))

    const connectBtn = document.createElement('button')
    connectBtn.type = 'button'
    connectBtn.textContent = project.permission !== 'granted' ? 'Connect' : 'Re-link'
    connectBtn.addEventListener('click', () =>
      void (project.permission !== 'granted'
        ? this.handleConnect(project.id)
        : this.handleRelink(project.id))
    )

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.textContent = 'Remove'
    removeBtn.addEventListener('click', () => void this.handleRemove(project.id))

    actions.appendChild(openBtn)
    actions.appendChild(connectBtn)
    actions.appendChild(removeBtn)
    card.appendChild(actions)
    return card
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg
    this.errorEl.hidden = false
  }

  private showStatus(msg: string): void {
    this.statusEl.textContent = msg
    this.statusEl.hidden = false
  }

  private clearMessages(): void {
    this.errorEl.hidden = true
    this.errorEl.textContent = ''
    this.statusEl.hidden = true
    this.statusEl.textContent = ''
  }

  private async handleSyncDevBridge(): Promise<void> {
    try {
      this.clearMessages()
      const result = await syncDevBridgeProjects()
      if (!result) {
        this.showError('Dev file bridge unavailable — run npm run dev.')
        return
      }
      const status = await getDevBridgeStatus()
      this.devBridgeAvailable = status.available
      this.showStatus(`Synced ${result.total} Creator Hub scene(s) (${result.imported} new).`)
      await this.refresh()
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleConnect(projectId: string): Promise<void> {
    try {
      this.clearMessages()
      if (this.devBridgeAvailable) {
        const result = await syncDevBridgeProjects()
        if (result && result.total > 0) {
          this.showStatus(`Synced ${result.total} scene(s).`)
          await this.refresh()
          return
        }
      }
      await connectProjectFolder(projectId)
      await this.refresh()
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleRelink(projectId: string): Promise<void> {
    try {
      this.clearMessages()
      await relinkProject(projectId)
      await this.refresh()
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleRemove(projectId: string): Promise<void> {
    await removeProject(projectId)
    await this.refresh()
  }
}