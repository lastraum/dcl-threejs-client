const KEYBOARD_ICON_SVG = `<svg class="editor-camera-controls-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">
  <rect x="2" y="6" width="20" height="12" rx="2" fill="none" stroke="currentColor" stroke-width="1.75"/>
  <circle cx="7" cy="11" r="1" fill="currentColor"/>
  <circle cx="10" cy="11" r="1" fill="currentColor"/>
  <circle cx="13" cy="11" r="1" fill="currentColor"/>
  <circle cx="16" cy="11" r="1" fill="currentColor"/>
  <rect x="8" y="14" width="8" height="1.5" rx="0.75" fill="currentColor"/>
</svg>`

const VIEWPORT_CONTROLS = [
  { keys: 'W A S D', label: 'Move' },
  { keys: 'Space', label: 'Up' },
  { keys: 'Shift', label: 'Down' },
  { keys: 'Q E', label: 'Rotate' },
  { keys: 'Alt', label: 'Sprint' },
  { keys: 'Right drag', label: 'Orbit' },
  { keys: 'Scroll', label: 'Zoom' },
  { keys: 'Left drag', label: 'Sculpt / paint' },
  { keys: 'G', label: 'Max height guide' },
  { keys: 'B', label: 'Avatar scale boxes' },
  { keys: '⌘/Ctrl Z', label: 'Undo' }
] as const

export class EditorCameraResetButton {
  private readonly root: HTMLDivElement
  private readonly controlsBtn: HTMLButtonElement
  private readonly popover: HTMLDivElement
  private readonly onDocumentPointerDown: (e: PointerEvent) => void

  constructor(
    parent: HTMLElement,
    handlers: {
      onReset: () => void
      onZoomIn: () => void
      onZoomOut: () => void
    }
  ) {
    this.root = document.createElement('div')
    this.root.className = 'editor-camera-reset-wrap'

    const controlsWrap = document.createElement('div')
    controlsWrap.className = 'editor-camera-controls-wrap'

    this.controlsBtn = document.createElement('button')
    this.controlsBtn.type = 'button'
    this.controlsBtn.className = 'editor-camera-controls-btn'
    this.controlsBtn.title = 'Viewport controls'
    this.controlsBtn.setAttribute('aria-label', 'Viewport controls')
    this.controlsBtn.setAttribute('aria-expanded', 'false')
    this.controlsBtn.innerHTML = KEYBOARD_ICON_SVG
    this.controlsBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      this.setControlsOpen(!this.popover.classList.contains('editor-camera-controls-popover--open'))
    })

    this.popover = document.createElement('div')
    this.popover.className = 'editor-camera-controls-popover'
    this.popover.setAttribute('role', 'dialog')
    this.popover.setAttribute('aria-label', 'Viewport controls')

    const title = document.createElement('div')
    title.className = 'editor-camera-controls-title'
    title.textContent = 'Controls'
    this.popover.appendChild(title)

    const list = document.createElement('ul')
    list.className = 'editor-camera-controls-list'
    for (const item of VIEWPORT_CONTROLS) {
      const row = document.createElement('li')
      const keys = document.createElement('span')
      keys.className = 'editor-camera-controls-keys'
      keys.textContent = item.keys
      const label = document.createElement('span')
      label.className = 'editor-camera-controls-label'
      label.textContent = item.label
      row.appendChild(keys)
      row.appendChild(label)
      list.appendChild(row)
    }
    this.popover.appendChild(list)

    controlsWrap.appendChild(this.controlsBtn)
    controlsWrap.appendChild(this.popover)

    const zoomWrap = document.createElement('div')
    zoomWrap.className = 'editor-camera-zoom-wrap'

    const zoomIn = document.createElement('button')
    zoomIn.type = 'button'
    zoomIn.className = 'editor-camera-zoom-btn'
    zoomIn.title = 'Zoom in'
    zoomIn.textContent = '+'
    zoomIn.addEventListener('click', handlers.onZoomIn)

    const zoomOut = document.createElement('button')
    zoomOut.type = 'button'
    zoomOut.className = 'editor-camera-zoom-btn'
    zoomOut.title = 'Zoom out'
    zoomOut.textContent = '−'
    zoomOut.addEventListener('click', handlers.onZoomOut)

    zoomWrap.appendChild(zoomIn)
    zoomWrap.appendChild(zoomOut)

    const reset = document.createElement('button')
    reset.type = 'button'
    reset.className = 'editor-camera-reset-btn'
    reset.title = 'Reset camera view'
    reset.textContent = 'Reset view'
    reset.addEventListener('click', handlers.onReset)

    this.root.appendChild(controlsWrap)
    this.root.appendChild(zoomWrap)
    this.root.appendChild(reset)
    parent.appendChild(this.root)

    this.onDocumentPointerDown = (e) => {
      if (!this.popover.classList.contains('editor-camera-controls-popover--open')) return
      const target = e.target
      if (target instanceof Node && this.root.contains(target)) return
      this.setControlsOpen(false)
    }
    document.addEventListener('pointerdown', this.onDocumentPointerDown)
  }

  dispose(): void {
    document.removeEventListener('pointerdown', this.onDocumentPointerDown)
    this.root.remove()
  }

  private setControlsOpen(open: boolean): void {
    this.popover.classList.toggle('editor-camera-controls-popover--open', open)
    this.controlsBtn.classList.toggle('editor-camera-controls-btn--open', open)
    this.controlsBtn.setAttribute('aria-expanded', open ? 'true' : 'false')
  }
}