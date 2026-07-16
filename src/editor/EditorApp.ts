import type { LoginResult } from '../auth/AuthClient'
import { editorUrlForProject, readEditorProjectIdFromUrl } from '../dcl/content/route'
import type { SocialShellChromeHandlers, SocialShellTab } from '../client/ui/explore/SocialShellTopNav'
import { EditorHubPage } from './ui/EditorHubPage'
import { TerrainEditorWorkspace } from './TerrainEditorWorkspace'
import { injectEditorStyles } from './editorStyles'

export type EditorAppShellOptions = SocialShellChromeHandlers & {
  login: LoginResult
  onNavigate: (tab: SocialShellTab) => void
}

/** `/editor` shell — hub page or terrain workspace on the same route. */
export class EditorApp {
  private container: HTMLElement | null = null
  private hub: EditorHubPage | null = null
  private workspace: TerrainEditorWorkspace | null = null
  private onPopState: (() => void) | null = null
  private shell: EditorAppShellOptions | null = null

  async start(container: HTMLElement, shell?: EditorAppShellOptions | null): Promise<void> {
    injectEditorStyles()
    document.body.classList.add('editor-route')
    this.container = container
    this.shell = shell ?? null
    this.onPopState = () => void this.syncFromUrl()
    window.addEventListener('popstate', this.onPopState)
    await this.syncFromUrl()
  }

  setLogin(login: LoginResult): void {
    if (this.shell) this.shell = { ...this.shell, login }
    this.hub?.setLogin(login)
  }

  dispose(): void {
    if (this.onPopState) window.removeEventListener('popstate', this.onPopState)
    void this.disposeWorkspace()
    this.hub?.dispose()
    this.hub = null
    if (this.container) this.container.innerHTML = ''
    this.container = null
    this.shell = null
    document.body.classList.remove('editor-route')
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
        onOpenProject: (id) => this.openProject(id),
        shell: this.shell
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
