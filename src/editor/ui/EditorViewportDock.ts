/**
 * Floating tool strip over the 3D viewport — quick nav without hunting the side panel.
 */
export type ViewportDockToolId = 'height' | 'splat' | 'grass' | 'env' | 'grid' | 'water' | 'save'

export type ViewportDockCallbacks = {
  onTool: (id: ViewportDockToolId) => void
  getActiveLayer?: () => 'height' | 'splat' | 'grass'
}

const TOOLS: { id: ViewportDockToolId; label: string; title: string }[] = [
  { id: 'height', label: '⛰', title: 'Sculpt height' },
  { id: 'splat', label: '🎨', title: 'Paint surface' },
  { id: 'grass', label: '🌿', title: 'Ez Grass blades' },
  { id: 'env', label: '🌤', title: 'Environment / ocean' },
  { id: 'grid', label: '▦', title: 'Toggle grid' },
  { id: 'water', label: '💧', title: 'Toggle water preview' },
  { id: 'save', label: '💾', title: 'Save project' }
]

export class EditorViewportDock {
  private readonly root: HTMLDivElement
  private readonly buttons = new Map<ViewportDockToolId, HTMLButtonElement>()

  constructor(parent: HTMLElement, private readonly cb: ViewportDockCallbacks) {
    this.root = document.createElement('div')
    this.root.className = 'editor-viewport-dock'
    this.root.setAttribute('role', 'toolbar')
    this.root.setAttribute('aria-label', 'Terrain tools')

    for (const t of TOOLS) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'editor-viewport-dock-btn'
      btn.dataset.tool = t.id
      btn.title = t.title
      btn.textContent = t.label
      btn.addEventListener('click', () => this.cb.onTool(t.id))
      this.buttons.set(t.id, btn)
      this.root.appendChild(btn)
    }

    parent.appendChild(this.root)
    this.syncActive()
  }

  syncActive(): void {
    const layer = this.cb.getActiveLayer?.() ?? 'height'
    for (const [id, btn] of this.buttons) {
      const on = id === layer
      btn.classList.toggle('editor-viewport-dock-btn--active', on)
    }
  }

  dispose(): void {
    this.root.remove()
  }
}
