import { defaultCreatorHubConfigPath } from '../localProjects/creatorHubConfig'
import {
  addProjectFromDroppedHandle,
  connectProjectFolder,
  getDevBridgeStatus,
  importCreatorHubProjects,
  isCreatorHubScenesLinked,
  isFileSystemAccessSupported,
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

const LOCAL_DEV_EDITOR_URL = 'http://localhost:5173/editor'

function isLocalhostEditor(): boolean {
  const host = window.location.hostname
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]'
}

export class EditorHubPage {
  private root: HTMLDivElement
  private grid: HTMLDivElement
  private errorEl: HTMLDivElement
  private statusEl: HTMLDivElement
  private helpEl: HTMLParagraphElement
  private localDevLink: HTMLAnchorElement | null = null
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
          this.showStatus(`Imported ${result.total} Creator Hub scene(s) from this machine.`)
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
    const configPath = defaultCreatorHubConfigPath()

    if (this.devBridgeAvailable) {
      this.helpEl.innerHTML =
        '<strong>Import Creator Hub</strong> reads your workspace from disk (same as the link script, no terminal). ' +
        'Scenes open and save directly while <code>npm run dev</code> runs.'
      return
    }

    if (!isFileSystemAccessSupported()) {
      this.helpEl.textContent =
        'Use Chrome or Edge on desktop. Safari/Firefox cannot open local scene folders in the browser.'
      return
    }

    if (isLocalhostEditor()) {
      this.helpEl.innerHTML =
        'Start <code>npm run dev</code> in this repo, then click <strong>Import Creator Hub</strong> — ' +
        'it reads <code>' +
        configPath +
        '</code> from your machine automatically.'
      return
    }

    this.helpEl.innerHTML =
      'On the live site, <strong>Import Creator Hub</strong> asks you to pick <code>' +
      configPath +
      '</code>, then <strong>Connect</strong> each scene folder. ' +
      'For one-click import (no folder picks), use the editor on this computer at ' +
      `<a href="${LOCAL_DEV_EDITOR_URL}" class="editor-hub-inline-link">${LOCAL_DEV_EDITOR_URL}</a> ` +
      'with <code>npm run dev</code> running.'
  }

  private renderActions(actions: HTMLDivElement): void {
    actions.innerHTML = ''

    const importBtn = document.createElement('button')
    importBtn.type = 'button'
    importBtn.className = 'editor-hub-add editor-hub-add--primary'
    importBtn.textContent = 'Import Creator Hub'
    importBtn.addEventListener('click', () => void this.handleImportCreatorHub())
    actions.appendChild(importBtn)

    if (!isFileSystemAccessSupported()) return

    const addBtn = document.createElement('button')
    addBtn.type = 'button'
    addBtn.className = 'editor-hub-add'
    addBtn.textContent = '+ Add scene folder'
    addBtn.addEventListener('click', () => void this.handleAddFolder())
    actions.appendChild(addBtn)

    if (!this.devBridgeAvailable && !isLocalhostEditor()) {
      this.localDevLink = document.createElement('a')
      this.localDevLink.href = LOCAL_DEV_EDITOR_URL
      this.localDevLink.className = 'editor-hub-add editor-hub-local-dev-link'
      this.localDevLink.textContent = 'Open local dev editor'
      this.localDevLink.title = 'One-click Creator Hub import while npm run dev runs on this machine'
      actions.appendChild(this.localDevLink)
    }
  }

  async refresh(): Promise<void> {
    const projects = await listProjects()
    this.grid.innerHTML = ''
    if (projects.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'editor-hub-empty'
      if (this.devBridgeAvailable) {
        empty.innerHTML = 'No projects yet. Click <strong>Import Creator Hub</strong>.'
      } else if (isLocalhostEditor()) {
        empty.innerHTML =
          'No projects yet. Run <code>npm run dev</code>, then click <strong>Import Creator Hub</strong>.'
      } else if (isFileSystemAccessSupported()) {
        empty.innerHTML =
          'No projects yet. Click <strong>Import Creator Hub</strong> and pick your config.json, ' +
          'or open <a href="' +
          LOCAL_DEV_EDITOR_URL +
          '" class="editor-hub-inline-link">localhost editor</a> with npm run dev for automatic import.'
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
    if (project.accessMode === 'dev-bridge' || this.devBridgeAvailable) {
      return 'Ready — open when listed (dev bridge)'
    }
    return 'Click Connect and pick this scene folder on disk'
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

    if (project.pathHint && project.permission !== 'granted' && project.accessMode !== 'dev-bridge') {
      const path = document.createElement('p')
      path.className = 'editor-hub-card-path'
      path.textContent = project.pathHint
      path.title = project.pathHint
      card.appendChild(path)
    }

    if (project.permission !== 'granted' && project.accessMode !== 'dev-bridge') {
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
    const needsConnect = project.permission !== 'granted' && project.accessMode !== 'dev-bridge'
    connectBtn.textContent = needsConnect ? 'Connect' : 'Re-link'
    connectBtn.addEventListener('click', () =>
      void (needsConnect ? this.handleConnect(project.id) : this.handleRelink(project.id))
    )

    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.textContent = 'Remove'
    removeBtn.addEventListener('click', () => void this.handleRemove(project.id))

    actions.appendChild(openBtn)
    if (project.accessMode !== 'dev-bridge') {
      actions.appendChild(connectBtn)
    }
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

  private async handleImportCreatorHub(): Promise<void> {
    try {
      this.clearMessages()
      const outcome = await importCreatorHubProjects()
      const { result, mode } = outcome

      if (mode === 'dev-bridge') {
        const status = await getDevBridgeStatus()
        this.devBridgeAvailable = status.available
        this.showStatus(
          `Imported ${result.total} scene(s) from Creator Hub on this machine (${result.imported} new).`
        )
      } else {
        let msg = `Imported ${result.total} workspace path(s). Click Connect on each card and pick the matching scene folder.`
        if (outcome.devImportUrl) {
          msg += ` Tip: for automatic import, use ${outcome.devImportUrl} with npm run dev.`
        }
        this.showStatus(msg)
      }
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

  private async handleConnect(projectId: string): Promise<void> {
    try {
      this.clearMessages()
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