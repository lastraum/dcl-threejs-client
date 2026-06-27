import { editorUrlForProject, readEditorProjectIdFromUrl } from '../dcl/content/route'
import { EditorHubPage } from './ui/EditorHubPage'
import { TerrainEditorWorkspace } from './TerrainEditorWorkspace'
import { injectEditorStyles } from './editorStyles'

/** `/editor` shell — hub page or terrain workspace on the same route. */
export class EditorApp {
  private container: HTMLElement | null = null
  private hub: EditorHubPage | null = null
  private workspace: TerrainEditorWorkspace | null = null
  private onPopState: (() => void) | null = null

  async start(container: HTMLElement): Promise<void> {
    injectEditorStyles()
    this.container = container
    this.onPopState = () => void this.syncFromUrl()
    window.addEventListener('popstate', this.onPopState)
    await this.syncFromUrl()
  }

  dispose(): void {
    if (this.onPopState) window.removeEventListener('popstate', this.onPopState)
    void this.disposeWorkspace()
    this.hub?.dispose()
    this.hub = null
    if (this.container) this.container.innerHTML = ''
    this.container = null
  }

  private async syncFromUrl(): Promise<void> {
    if (!this.container) return
    const projectId = readEditorProjectIdFromUrl()
    if (projectId) {
      if (this.hub) {
        this.hub.dispose()
        this.hub = null
      }
      if (!this.workspace) {
        this.container.innerHTML = ''
        this.workspace = new TerrainEditorWorkspace(this.container, projectId, {
          onBack: () => this.backToHub()
        })
        try {
          await this.workspace.mount()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          this.container.innerHTML = `<div class="editor-hub-error" style="padding:24px">${msg}</div>`
          this.workspace.dispose()
          this.workspace = null
        }
      }
      return
    }

    await this.disposeWorkspace()
    if (!this.hub) {
      if (this.container) this.container.innerHTML = ''
      this.hub = new EditorHubPage(this.container, {
        onOpenProject: (id) => this.openProject(id)
      })
    } else {
      await this.hub.refresh()
    }
  }

  private openProject(projectId: string): void {
    editorUrlForProject(projectId)
    void this.syncFromUrl()
  }

  private backToHub(): void {
    editorUrlForProject(null)
    void this.syncFromUrl()
  }

  private async disposeWorkspace(): Promise<void> {
    this.workspace?.dispose()
    this.workspace = null
  }
}