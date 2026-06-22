import { playUiClick } from '../UiSfx'
import { GraphicsSettingsView } from './GraphicsSettingsView'
import { SoundsSettingsView } from './SoundsSettingsView'

export type PreferencesTab = 'graphics' | 'sounds' | 'controls' | 'chat'

type TabDef = {
  id: PreferencesTab
  label: string
  icon: string
}

const TABS: TabDef[] = [
  {
    id: 'graphics',
    label: 'GRAPHICS',
    icon: `<svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4" width="18" height="13" rx="1.5" stroke="currentColor" stroke-width="1.5"/><path d="M8 20h8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
  },
  {
    id: 'sounds',
    label: 'SOUNDS',
    icon: `<svg viewBox="0 0 24 24" fill="none"><path d="M11 5L6 9H3v6h3l5 4V5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M16 9a4 4 0 0 1 0 6M18 7a7 7 0 0 1 0 10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>`
  },
  {
    id: 'controls',
    label: 'CONTROLS',
    icon: `<svg viewBox="0 0 24 24" fill="none"><rect x="4" y="8" width="16" height="8" rx="2" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="12" r="1.5" fill="currentColor"/><circle cx="12" cy="12" r="1.5" fill="currentColor"/><circle cx="16" cy="12" r="1.5" fill="currentColor"/></svg>`
  },
  {
    id: 'chat',
    label: 'CHAT',
    icon: `<svg viewBox="0 0 24 24" fill="none"><path d="M5 6h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H9l-4 3v-3H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/></svg>`
  }
]

export type PreferencesPanelOptions = {
  onVisibilityChange?: (visible: boolean) => void
  onOpen?: () => void
}

/** Right-side preferences panel — graphics, audio, controls, chat. Does not block world input. */
export class PreferencesPanel {
  readonly root: HTMLElement
  private readonly tabBar: HTMLElement
  private readonly contentArea: HTMLElement
  private readonly closeBtn: HTMLElement
  private graphicsSettingsView: GraphicsSettingsView | null = null
  private soundsSettingsView: SoundsSettingsView | null = null
  private activeTab: PreferencesTab = 'graphics'
  private visible = false
  private readonly onVisibilityChange?: (visible: boolean) => void
  private readonly onOpen?: () => void

  constructor(opts: PreferencesPanelOptions = {}) {
    this.onVisibilityChange = opts.onVisibilityChange
    this.onOpen = opts.onOpen
    this.root = document.createElement('div')
    this.root.className = 'preferences-panel'
    this.root.setAttribute('hidden', '')

    this.root.innerHTML = `
      <aside class="preferences-panel__panel" role="dialog" aria-label="Preferences" aria-modal="false">
        <div class="preferences-panel__header">
          <span class="preferences-panel__title">GRAPHICS</span>
          <button class="preferences-panel__close" type="button" aria-label="Close">&times;</button>
        </div>
        <div class="preferences-panel__body">
          <nav class="preferences-panel__tabs" role="tablist" aria-label="Preferences"></nav>
          <div class="preferences-panel__content"></div>
        </div>
      </aside>
    `

    this.tabBar = this.root.querySelector('.preferences-panel__tabs')!
    this.contentArea = this.root.querySelector('.preferences-panel__content')!
    this.closeBtn = this.root.querySelector('.preferences-panel__close')!

    this.buildTabs()
    this.closeBtn.addEventListener('click', () => {
      playUiClick()
      this.hide()
    })
    window.addEventListener('keydown', this.onKeyDown)
    document.body.appendChild(this.root)
  }

  private buildTabs(): void {
    for (const tab of TABS) {
      const btn = document.createElement('button')
      btn.className = 'preferences-panel__tab'
      btn.dataset.tab = tab.id
      btn.type = 'button'
      btn.setAttribute('role', 'tab')
      btn.title = tab.label
      btn.setAttribute('aria-label', tab.label)
      btn.innerHTML = `<span class="preferences-panel__tab-icon">${tab.icon}</span>`
      btn.addEventListener('click', () => {
        playUiClick()
        this.switchTab(tab.id)
      })
      this.tabBar.appendChild(btn)
    }
  }

  private onKeyDown = (e: KeyboardEvent): void => {
    if (this.isTyping()) return

    if (e.code === 'KeyP') {
      e.preventDefault()
      this.toggle()
      return
    }

    if (e.code === 'Escape' && this.visible) {
      e.preventDefault()
      this.hide()
    }
  }

  private isTyping(): boolean {
    const el = document.activeElement
    if (!el) return false
    if (el instanceof HTMLInputElement) {
      const type = el.type.toLowerCase()
      return type !== 'checkbox' && type !== 'radio' && type !== 'button'
    }
    if (el instanceof HTMLTextAreaElement) return true
    if (el instanceof HTMLElement && el.isContentEditable) return true
    return false
  }

  show(tab: PreferencesTab = 'graphics'): void {
    this.onOpen?.()
    this.visible = true
    this.root.removeAttribute('hidden')
    requestAnimationFrame(() => this.root.classList.add('is-open'))
    this.switchTab(tab)
    this.onVisibilityChange?.(true)
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.root.classList.remove('is-open')
    this.onVisibilityChange?.(false)
    setTimeout(() => {
      if (!this.visible) this.root.setAttribute('hidden', '')
    }, 280)
  }

  toggle(tab?: PreferencesTab): void {
    if (this.visible) this.hide()
    else this.show(tab)
  }

  isVisible(): boolean {
    return this.visible
  }

  private switchTab(id: PreferencesTab): void {
    this.activeTab = id
    for (const btn of this.tabBar.querySelectorAll('.preferences-panel__tab')) {
      btn.classList.toggle('is-active', (btn as HTMLElement).dataset.tab === id)
    }
    const titleEl = this.root.querySelector('.preferences-panel__title')
    const tabDef = TABS.find((tab) => tab.id === id)
    if (titleEl) titleEl.textContent = tabDef?.label ?? 'PREFERENCES'
    this.renderContent()
  }

  private renderContent(): void {
    this.contentArea.innerHTML = ''
    this.graphicsSettingsView?.dispose()
    this.graphicsSettingsView = null
    this.soundsSettingsView?.dispose()
    this.soundsSettingsView = null

    if (this.activeTab === 'graphics') {
      this.graphicsSettingsView = new GraphicsSettingsView()
      this.contentArea.appendChild(this.graphicsSettingsView.root)
      return
    }

    if (this.activeTab === 'sounds') {
      this.soundsSettingsView = new SoundsSettingsView()
      this.contentArea.appendChild(this.soundsSettingsView.root)
      return
    }

    const placeholder = document.createElement('div')
    placeholder.className = 'preferences-panel__placeholder'
    placeholder.textContent = `${this.activeTab.toUpperCase()} — Coming soon`
    this.contentArea.appendChild(placeholder)
  }

  dispose(): void {
    window.removeEventListener('keydown', this.onKeyDown)
    this.graphicsSettingsView?.dispose()
    this.soundsSettingsView?.dispose()
    this.root.remove()
  }
}