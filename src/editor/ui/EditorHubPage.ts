import {
  addProjectFromDroppedHandle,
  connectProjectFolder,
  getDevBridgeStatus,
  importCreatorHubConfig,
  isCreatorHubScenesLinked,
  isFileSystemAccessSupported,
  linkCreatorHubScenesFolder,
  listProjects,
  pickAndAddProject,
  relinkProject,
  removeProject,
  rescanCreatorHubScenes,
  syncDevBridgeProjects,
  type LocalProjectRecord
} from '../localProjects/projectStore'

export type EditorHubPageCallbacks = {
  onOpenProject: (projectId: string) => void
}

const CREATOR_HUB_SCENES_SYMLINK = '~/Documents/CreatorHubScenes'

export class EditorHubPage {
  private root: HTMLDivElement
  private grid: HTMLDivElement
  private errorEl: HTMLDivElement
  private statusEl: HTMLDivElement
  private helpEl: HTMLParagraphElement
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

    this.helpEl = document.createElement('p')
    this.helpEl.className = 'editor-hub-path-hint'
    header.appendChild(this.helpEl)

    const actions = document.createElement('div')
    actions.className = 'editor-hub-actions'
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
    this.grid.className = 'editor-hub-grid editor-hub-dropzone'
    this.root.appendChild(this.grid)

    this.bindFolderDrop()
    void this.bootstrap(actions)
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

  private async bootstrap(actions: HTMLDivElement): Promise<void> {
    const bridgeStatus = await getDevBridgeStatus()
    this.devBridgeAvailable = bridgeStatus.available
    this.renderActions(actions)
    this.renderHelp()

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

  private renderHelp(): void {
    if (this.devBridgeAvailable) {
      this.helpEl.innerHTML =
        'Local <code>npm run dev</code> — Creator Hub scenes sync automatically from your machine.'
      return
    }

    if (!isFileSystemAccessSupported()) {
      this.helpEl.textContent =
        'Use Chrome or Edge on desktop. Safari/Firefox cannot open local scene folders in the browser.'
      return
    }

    this.helpEl.innerHTML =
      `Live / hosted build — pick a scene folder from disk (Chrome blocks Creator Hub’s <code>~/Library</code> path). ` +
      `Run <code>node scripts/link-creator-hub-scenes.mjs</code> once, then link <code>${CREATOR_HUB_SCENES_SYMLINK}</code> ` +
      'or drag a scene folder here.'
  }

  private renderActions(actions: HTMLDivElement): void {
    actions.innerHTML = ''

    if (this.devBridgeAvailable) {
      const syncDevBtn = document.createElement('button')
      syncDevBtn.type = 'button'
      syncDevBtn.className = 'editor-hub-add editor-hub-add--primary'
      syncDevBtn.textContent = 'Sync Creator Hub (dev)'
      syncDevBtn.addEventListener('click', () => void this.handleSyncDevBridge())
      actions.appendChild(syncDevBtn)
      return
    }

    if (!isFileSystemAccessSupported()) return

    const linkBtn = document.createElement('button')
    linkBtn.type = 'button'
    linkBtn.className = 'editor-hub-add editor-hub-add--primary'
    linkBtn.textContent = 'Link Scenes folder'
    linkBtn.title = `Pick ${CREATOR_HUB_SCENES_SYMLINK} or your Creator Hub Scenes directory`
    linkBtn.addEventListener('click', () => void this.handleLinkScenesFolder())
    actions.appendChild(linkBtn)

    const importBtn = document.createElement('button')
    importBtn.type = 'button'
    importBtn.className = 'editor-hub-add'
    importBtn.textContent = 'Import config.json'
    importBtn.title = 'Import Creator Hub workspace list, then Connect each scene folder'
    importBtn.addEventListener('click', () => void this.handleImportConfig())
    actions.appendChild(importBtn)

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'editor-hub-add'
    addBtn.textContent = '+ Add scene folder'
    addBtn.addEventListener('click', () => void this.handleAddFolder())
    actions.appendChild(addBtn)

    const rescanBtn = document.createElement('button')
    rescanBtn.type = 'button'
    rescanBtn.className = 'editor-hub-add'
    rescanBtn.textContent = 'Rescan linked Scenes'
    rescanBtn.addEventListener('click', () => void this.handleRescanLinked())
    actions.appendChild(rescanBtn)
  }

  async refresh(): Promise<void> {
    const projects = await listProjects()
    this.grid.innerHTML = ''
    if (projects.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'editor-hub-empty'
      if (this.devBridgeAvailable) {
        empty.textContent = 'No projects yet. Click Sync Creator Hub (dev).'
      } else if (isFileSystemAccessSupported()) {
        empty.innerHTML =
          `No projects yet. <strong>Link Scenes folder</strong> (try <code>${CREATOR_HUB_SCENES_SYMLINK}</code>), ` +
          '<strong>Import config.json</strong>, or drag a scene folder here.'
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

  private pendingConnectHint(project: LocalProjectRecord): string {
    if (this.devBridgeAvailable) {
      return 'Not connected — click Sync Creator Hub (dev) or Connect'
    }
    if (project.pathHint) {
      return `Not connected — click Connect and pick this folder on disk`
    }
    return 'Not connected — click Connect and pick the scene folder'
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
      warn.textContent = this.pendingConnectHint(project)
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

  private async handleLinkScenesFolder(): Promise<void> {
    try {
      this.clearMessages()
      const result = await linkCreatorHubScenesFolder()
      this.showStatus(`Linked Scenes folder — ${result.total} scene(s) (${result.imported} new).`)
      await this.refresh()
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
      this.showError(e instanceof Error ? e.message : String(e))
    }
  }

  private async handleImportConfig(): Promise<void> {
    try {
      this.clearMessages()
      const result = await importCreatorHubConfig()
      this.showStatus(
        `Imported ${result.total} workspace path(s) — click Connect on each card and pick the matching folder.`
      )
      await this.refresh()
    } catch (e) {
      if (e instanceof Error && e.name === 'AbortError') return
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

  private async handleRescanLinked(): Promise<void> {
    try {
      this.clearMessages()
      const result = await rescanCreatorHubScenes()
      if (!result) {
        this.showError(`No Scenes folder linked yet — use Link Scenes folder (${CREATOR_HUB_SCENES_SYMLINK}).`)
        return
      }
      this.showStatus(`Rescanned — ${result.total} scene(s) (${result.imported} new).`)
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