import { RECOMMENDED_SCENES_FOLDER } from '../localProjects/creatorHubPaths'
import {
  addProjectFromDroppedHandle,
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
  private helpEl: HTMLParagraphElement

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

    this.helpEl = document.createElement('p')
    this.helpEl.className = 'editor-hub-path-hint'
    header.appendChild(this.helpEl)

    const actions = document.createElement('div')
    actions.className = 'editor-hub-actions'
    this.renderActions(actions)
    header.appendChild(actions)

    this.renderHelp()
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
    this.grid.className = 'editor-hub-grid editor-hub-dropzone'
    this.root.appendChild(this.grid)

    this.bindFolderDrop()
    void this.bootstrap()
  }

  dispose(): void {
    this.root.remove()
  }

  private bindFolderDrop(): void {
    if (!isFileSystemAccessSupported()) return

    const onDragOver = (e: DragEvent) => {
      if (!this.hasDirectoryDrop(e)) return
      e.preventDefault()
      this.grid.classList.add('editor-hub-dropzone--active')
    }
    const onDragLeave = () => {
      this.grid.classList.remove('editor-hub-dropzone--active')
    }
    const onDrop = (e: DragEvent) => {
      this.grid.classList.remove('editor-hub-dropzone--active')
      if (!this.hasDirectoryDrop(e)) return
      e.preventDefault()
      void this.handleFolderDrop(e)
    }

    this.grid.addEventListener('dragover', onDragOver)
    this.grid.addEventListener('dragleave', onDragLeave)
    this.grid.addEventListener('drop', onDrop)
  }

  private hasDirectoryDrop(e: DragEvent): boolean {
    const items = e.dataTransfer?.items
    if (!items) return false
    for (const item of items) {
      if (item.kind === 'file') return true
    }
    return false
  }

  private async handleFolderDrop(e: DragEvent): Promise<void> {
    const items = e.dataTransfer?.items
    if (!items) return
    try {
      this.clearMessages()
      let added = 0
      for (const item of items) {
        if (item.kind !== 'file') continue
        const handle = await item.getAsFileSystemHandle()
        if (!handle || handle.kind !== 'directory') continue
        await addProjectFromDroppedHandle(handle as FileSystemDirectoryHandle)
        added++
      }
      if (added > 0) {
        this.showStatus(`Added ${added} scene folder(s).`)
        await this.refresh()
      }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return
      this.showError(err instanceof Error ? err.message : String(err))
    }
  }

  private async bootstrap(): Promise<void> {
    if (await isCreatorHubScenesLinked()) {
      try {
        const result = await rescanCreatorHubScenes()
        if (result && (result.imported > 0 || result.updated > 0)) {
          this.showStatus(`Found ${result.total} scene(s) (${result.imported} new).`)
        }
      } catch {
        /* permission may need re-grant on open */
      }
    }
    await this.refresh()
  }

  private renderHelp(): void {
    if (!isFileSystemAccessSupported()) {
      this.helpEl.textContent =
        'Use Chrome or Edge on desktop. Safari and Firefox cannot open local scene folders in the browser.'
      return
    }

    this.helpEl.innerHTML =
      `Keep scene folders in <strong>Documents</strong>, <strong>Downloads</strong>, or <strong>Desktop</strong> ` +
      `(Chrome blocks Creator Hub’s Library folder). Recommended: <code>${RECOMMENDED_SCENES_FOLDER}</code> ` +
      '— each subfolder needs a <code>scene.json</code>. Click <strong>Link Scenes folder</strong> once; ' +
      'use <strong>Rescan</strong> when you add scenes. You can also drag a scene folder here.'
  }

  private renderActions(actions: HTMLDivElement): void {
    actions.innerHTML = ''

    if (!isFileSystemAccessSupported()) return

    const linkBtn = document.createElement('button')
    linkBtn.type = 'button'
    linkBtn.className = 'editor-hub-add editor-hub-add--primary'
    linkBtn.textContent = 'Link Scenes folder'
    linkBtn.title = `Pick ${RECOMMENDED_SCENES_FOLDER} or your projects parent folder`
    linkBtn.addEventListener('click', () => void this.handleLinkScenesFolder())
    actions.appendChild(linkBtn)

    const rescanBtn = document.createElement('button')
    rescanBtn.type = 'button'
    rescanBtn.className = 'editor-hub-add'
    rescanBtn.textContent = 'Rescan'
    rescanBtn.title = 'Pick up new scene subfolders after linking'
    rescanBtn.addEventListener('click', () => void this.handleRescan())
    actions.appendChild(rescanBtn)

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'editor-hub-add'
    addBtn.textContent = '+ Add scene folder'
    addBtn.addEventListener('click', () => void this.handleAddFolder())
    actions.appendChild(addBtn)
  }

  async refresh(): Promise<void> {
    const projects = await listProjects()
    this.grid.innerHTML = ''
    if (projects.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'editor-hub-empty'
      if (isFileSystemAccessSupported()) {
        empty.innerHTML =
          `No projects yet. Put scenes in <code>${RECOMMENDED_SCENES_FOLDER}</code>, ` +
          'then click <strong>Link Scenes folder</strong> or drag a scene folder here.'
      } else {
        empty.textContent = 'No projects yet. Open this page in Chrome or Edge on desktop.'
      }
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

    const name = document.createElement('h2')
    name.textContent = project.name
    card.appendChild(name)

    const meta = document.createElement('p')
    meta.className = 'editor-hub-card-meta'
    const parcel = project.parcelCount ? `${project.parcelCount} parcel(s)` : 'Unknown size'
    const base = project.baseParcel ? ` · base ${project.baseParcel}` : ''
    const opened = new Date(project.lastOpenedAt).toLocaleString()
    const folder = project.folderName ? `${project.folderName} · ` : ''
    meta.textContent = `${folder}${parcel}${base} · opened ${opened}`
    card.appendChild(meta)

    if (project.permission !== 'granted') {
      const warn = document.createElement('p')
      warn.className = 'editor-hub-card-warn'
      warn.textContent = 'Folder access expired — click Re-link and pick this scene folder again'
      card.appendChild(warn)
    }

    const actions = document.createElement('div')
    actions.className = 'editor-hub-card-actions'

    const openBtn = document.createElement('button')
    openBtn.type = 'button'
    openBtn.textContent = 'Open'
    openBtn.disabled = project.permission !== 'granted'
    openBtn.addEventListener('click', () => this.callbacks.onOpenProject(project.id))

    const relinkBtn = document.createElement('button')
    relinkBtn.type = 'button'
    relinkBtn.textContent = project.permission !== 'granted' ? 'Re-link' : 'Change folder'
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

  private async handleLinkScenesFolder(): Promise<void> {
    try {
      this.clearMessages()
      const result = await linkCreatorHubScenesFolder()
      this.showStatus(`Linked — ${result.total} scene(s) ready (${result.imported} new).`)
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
        this.showError(`No folder linked yet. Click Link Scenes folder and choose e.g. ${RECOMMENDED_SCENES_FOLDER}.`)
        return
      }
      this.showStatus(`Rescanned — ${result.total} scene(s) (${result.imported} new).`)
      await this.refresh()
    } catch (e) {
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleAddFolder(): Promise<void> {
    try {
      this.clearMessages()
      const record = await pickAndAddProject()
      if (record) {
        this.showStatus(`Added ${record.name}.`)
        await this.refresh()
      }
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