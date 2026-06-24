import { defaultCreatorHubScenesPath } from '../localProjects/creatorHubPaths'
import {
  isCreatorHubScenesLinked,
  isFileSystemAccessSupported,
  linkCreatorHubScenesFolder,
  listProjects,
  pickAndAddProject,
  relinkProject,
  removeProject,
  rescanCreatorHubScenes,
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
    subtitle.textContent =
      'Link your Creator Hub Scenes folder to auto-import SDK7 projects, or add individual folders manually.'
    header.appendChild(title)
    header.appendChild(subtitle)

    const actions = document.createElement('div')
    actions.className = 'editor-hub-actions'

    const chPath = defaultCreatorHubScenesPath()
    const linkChBtn = document.createElement('button')
    linkChBtn.type = 'button'
    linkChBtn.className = 'editor-hub-add editor-hub-add--primary'
    linkChBtn.textContent = 'Link Creator Hub Scenes'
    linkChBtn.title = `Select: ${chPath}`
    linkChBtn.addEventListener('click', () => void this.handleLinkCreatorHub())

    const rescanBtn = document.createElement('button')
    rescanBtn.type = 'button'
    rescanBtn.className = 'editor-hub-add'
    rescanBtn.textContent = 'Rescan'
    rescanBtn.addEventListener('click', () => void this.handleRescan())

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'editor-hub-add'
    addBtn.textContent = '+ Add folder'
    addBtn.addEventListener('click', () => void this.handleAdd())

    actions.appendChild(linkChBtn)
    actions.appendChild(rescanBtn)
    actions.appendChild(addBtn)
    header.appendChild(actions)

    const pathHint = document.createElement('p')
    pathHint.className = 'editor-hub-path-hint'
    pathHint.textContent = `Creator Hub default: ${chPath}`
    header.appendChild(pathHint)

    this.root.appendChild(header)

    this.errorEl = document.createElement('div')
    this.errorEl.className = 'editor-hub-error'
    this.errorEl.hidden = true
    this.root.appendChild(this.errorEl)

    this.statusEl = document.createElement('div')
    this.statusEl.className = 'editor-hub-status'
    this.statusEl.hidden = true
    this.root.appendChild(this.statusEl)

    if (!isFileSystemAccessSupported()) {
      this.showError('File System Access API is not available. Use Chrome or Edge for local project editing.')
    }

    this.grid = document.createElement('div')
    this.grid.className = 'editor-hub-grid'
    this.root.appendChild(this.grid)

    void this.bootstrap()
  }

  dispose(): void {
    this.root.remove()
  }

  private async bootstrap(): Promise<void> {
    if (await isCreatorHubScenesLinked()) {
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
      empty.innerHTML =
        `No projects indexed yet.<br><br>` +
        `Click <b>Link Creator Hub Scenes</b> and select:<br>` +
        `<code>${defaultCreatorHubScenesPath()}</code>`
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

    const name = document.createElement('h2')
    name.textContent = project.name
    card.appendChild(name)

    const meta = document.createElement('p')
    meta.className = 'editor-hub-card-meta'
    const parcel = project.parcelCount ? `${project.parcelCount} parcel(s)` : 'Unknown size'
    const base = project.baseParcel ? ` · base ${project.baseParcel}` : ''
    const opened = new Date(project.lastOpenedAt).toLocaleString()
    const source =
      project.source === 'creator-hub' && project.folderName
        ? `Creator Hub · ${project.folderName} · `
        : ''
    meta.textContent = `${source}${parcel}${base} · opened ${opened}`
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

  private async handleLinkCreatorHub(): Promise<void> {
    try {
      this.clearMessages()
      const result = await linkCreatorHubScenesFolder()
      this.showStatus(`Linked Creator Hub — imported ${result.imported} scene(s), ${result.total} total.`)
      await this.refresh()
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleRescan(): Promise<void> {
    try {
      this.clearMessages()
      const result = await rescanCreatorHubScenes()
      if (!result) {
        this.showError('Creator Hub not linked yet — use Link Creator Hub Scenes first.')
        return
      }
      this.showStatus(`Rescanned — ${result.total} scene(s) (${result.imported} new, ${result.updated} updated).`)
      await this.refresh()
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleAdd(): Promise<void> {
    try {
      this.clearMessages()
      await pickAndAddProject()
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