import { notificationPrefs } from '../../../social/notificationPrefs'
import {
  chatTranslationSettings,
  LANGUAGE_OPTIONS,
  type LanguageCode
} from '../../../social/translation'

/**
 * Preferences → Chat: translation + notification banners (incl. Wearable Pool claims).
 * Per-channel auto-translate is toggled from the chat header (A 文).
 */
export class ChatSettingsView {
  readonly root: HTMLElement
  private unsubPrefs: (() => void) | null = null

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'
    this.render()
  }

  private render(): void {
    this.root.innerHTML = ''
    this.unsubPrefs?.()
    this.unsubPrefs = null

    const scroll = document.createElement('div')
    scroll.className = 'gfx-settings__scroll'

    // ── Notifications ──────────────────────────────────────────────────────
    const notifSection = document.createElement('section')
    notifSection.className = 'gfx-settings__section'

    const notifTitle = document.createElement('div')
    notifTitle.className = 'gfx-settings__section-title'
    notifTitle.textContent = 'Notifications'
    notifSection.appendChild(notifTitle)

    const notifGrid = document.createElement('div')
    notifGrid.className = 'gfx-settings__grid'

    const prefs = notificationPrefs.get()

    notifGrid.appendChild(
      this.toggleRow(
        'Show toast banners',
        'Chat, community, and system toasts at the top of the screen.',
        prefs.enabled,
        (on) => notificationPrefs.setEnabled(on)
      )
    )
    notifGrid.appendChild(
      this.toggleRow(
        'Wearable Pool claims',
        'When someone else claims from the pool, show a toast (uses the social LiveKit room — works across scenes).',
        prefs.poolClaims,
        (on) => notificationPrefs.setPoolClaims(on)
      )
    )
    notifSection.appendChild(notifGrid)

    const notifHint = document.createElement('p')
    notifHint.className = 'chat-settings-hint'
    notifHint.textContent =
      'Your own pool claim still opens the win modal. Peer claim toasts are off when master banners are disabled.'
    notifSection.appendChild(notifHint)
    scroll.appendChild(notifSection)

    // ── Translation ────────────────────────────────────────────────────────
    const section = document.createElement('section')
    section.className = 'gfx-settings__section'

    const title = document.createElement('div')
    title.className = 'gfx-settings__section-title'
    title.textContent = 'Translation'
    section.appendChild(title)

    const grid = document.createElement('div')
    grid.className = 'gfx-settings__grid'

    const row = document.createElement('div')
    row.className = 'gfx-settings__row'

    const label = document.createElement('div')
    label.className = 'gfx-settings__label'
    label.textContent = 'Translate messages to'
    row.appendChild(label)

    const wrap = document.createElement('div')
    wrap.className = 'gfx-settings__dropdown'

    const select = document.createElement('select')
    select.className = 'gfx-settings__select'
    select.setAttribute('aria-label', 'Translate messages to')
    const current = chatTranslationSettings.getPreferredLanguage()
    for (const opt of LANGUAGE_OPTIONS) {
      const option = document.createElement('option')
      option.value = opt.code
      option.textContent = opt.label
      if (opt.code === current) option.selected = true
      select.appendChild(option)
    }
    select.addEventListener('change', () => {
      chatTranslationSettings.setPreferredLanguage(select.value as LanguageCode)
    })
    wrap.appendChild(select)
    row.appendChild(wrap)
    grid.appendChild(row)
    section.appendChild(grid)

    const hint = document.createElement('p')
    hint.className = 'chat-settings-hint'
    hint.textContent =
      'Use the A 文 button in a chat channel header to auto-translate new messages. Hover a message for Translate / See original.'
    section.appendChild(hint)

    scroll.appendChild(section)
    this.root.appendChild(scroll)
  }

  private toggleRow(
    labelText: string,
    hint: string,
    checked: boolean,
    onChange: (on: boolean) => void
  ): HTMLElement {
    const row = document.createElement('div')
    row.className = 'gfx-settings__row gfx-settings__row--stack'

    const top = document.createElement('div')
    top.className = 'gfx-settings__row-top'
    top.style.display = 'flex'
    top.style.alignItems = 'center'
    top.style.justifyContent = 'space-between'
    top.style.gap = '12px'
    top.style.width = '100%'

    const label = document.createElement('div')
    label.className = 'gfx-settings__label'
    label.textContent = labelText
    top.appendChild(label)

    const toggle = document.createElement('input')
    toggle.type = 'checkbox'
    toggle.className = 'gfx-settings__checkbox'
    toggle.checked = checked
    toggle.setAttribute('aria-label', labelText)
    toggle.addEventListener('change', () => onChange(toggle.checked))
    top.appendChild(toggle)
    row.appendChild(top)

    const sub = document.createElement('p')
    sub.className = 'chat-settings-hint'
    sub.style.margin = '4px 0 0'
    sub.textContent = hint
    row.appendChild(sub)

    return row
  }

  dispose(): void {
    this.unsubPrefs?.()
    this.unsubPrefs = null
    this.root.remove()
  }
}
