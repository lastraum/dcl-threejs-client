import {
  isFileSystemAccessSupported,
  listProjects,
  pickAndAddProject,
  relinkProject,
  removeProject,
  type LocalProjectRecord
} from '../localProjects/projectStore'

export type EditorHubPageCallbacks = {
  onOpenProject: (projectId: string) => void
}

export class EditorHubPage {
  private root: HTMLDivElement
  private grid: HTMLDivElement
  private errorEl: HTMLDivElement

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
    const subtitle = document.createElement('p')
    subtitle.textContent = 'Open SDK7 project folders from your computer. Projects are indexed in this browser only.'
    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'editor-hub-add'
    addBtn.textContent = '+ Add project folder'
    addBtn.addEventListener('click', () => void this.handleAdd())
    header.appendChild(title)
    header.appendChild(subtitle)
    header.appendChild(addBtn)
    this.root.appendChild(header)

    this.errorEl = document.createElement('div')
    this.errorEl.className = 'editor-hub-error'
    this.errorEl.hidden = true
    this.root.appendChild(this.errorEl)

    if (!isFileSystemAccessSupported()) {
      this.showError('File System Access API is not available. Use Chrome or Edge for local project editing.')
    }

    this.grid = document.createElement('div')
    this.grid.className = 'editor-hub-grid'
    this.root.appendChild(this.grid)

    void this.refresh()
  }

  dispose(): void {
    this.root.remove()
  }

  async refresh(): Promise<void> {
    const projects = await listProjects()
    this.grid.innerHTML = ''
    if (projects.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'editor-hub-empty'
      empty.textContent = 'No projects yet — add an SDK7 scene folder to get started.'
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

    const name = document.createElement('h2')
    name.textContent = project.name
    card.appendChild(name)

    const meta = document.createElement('p')
    meta.className = 'editor-hub-card-meta'
    const parcel = project.parcelCount ? `${project.parcelCount} parcel(s)` : 'Unknown size'
    const base = project.baseParcel ? ` · base ${project.baseParcel}` : ''
    const opened = new Date(project.lastOpenedAt).toLocaleString()
    meta.textContent = `${parcel}${base} · opened ${opened}`
    card.appendChild(meta)

    if (project.permission !== 'granted') {
      const warn = document.createElement('p')
      warn.className = 'editor-hub-card-warn'
      warn.textContent = 'Folder permission required — click Re-link or Open'
      card.appendChild(warn)
    }

    const actions = document.createElement('div')
    actions.className = 'editor-hub-card-actions'

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.textContent = 'Open'
    openBtn.addEventListener('click', () => this.callbacks.onOpenProject(project.id))

    const relinkBtn = document.createElement('button')
    relinkBtn.type = 'button'
    relinkBtn.textContent = 'Re-link'
    relinkBtn.addEventListener('click', () => void this.handleRelink(project.id))

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.textContent = 'Remove'
    removeBtn.addEventListener('click', () => void this.handleRemove(project.id))

    actions.appendChild(openBtn)
    actions.appendChild(relinkBtn)
    actions.appendChild(removeBtn)
    card.appendChild(actions)
    return card
  }

  private showError(msg: string): void {
    this.errorEl.textContent = msg
    this.errorEl.hidden = false
  }

  private clearError(): void {
    this.errorEl.hidden = true
    this.errorEl.textContent = ''
  }

  private async handleAdd(): Promise<void> {
    try {
      this.clearError()
      await pickAndAddProject()
      await this.refresh()
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleRelink(projectId: string): Promise<void> {
    try {
      this.clearError()
      await relinkProject(projectId)
      await this.refresh()
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleRemove(projectId: string): Promise<void> {
    await removeProject(projectId)
    await this.refresh()
  }
}