import {
  chatTranslationSettings,
  LANGUAGE_OPTIONS,
  type LanguageCode
} from '../../../social/translation'

/**
 * Preferences → Chat: preferred translation language.
 * Per-channel auto-translate is toggled from the chat header (A 文).
 */
export class ChatSettingsView {
  readonly root: HTMLElement

  constructor() {
    this.root = document.createElement('div')
    this.root.className = 'gfx-settings'
    this.render()
  }

  private render(): void {
    this.root.innerHTML = ''

    const scroll = document.createElement('div')
    scroll.className = 'gfx-settings__scroll'

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

  dispose(): void {
    this.root.remove()
  }
}
