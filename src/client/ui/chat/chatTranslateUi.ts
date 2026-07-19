import {
  chatTranslationService,
  chatTranslationSettings,
  type MessageTranslation
} from '../../../social/translation'
import type { ChatTextLine } from '../../../social/types'

/**
 * Mount inline translate / see-original controls on a chat bubble.
 * Visibility rules mirror Unity Explorer ChatEntryView.
 */
export function appendTranslateControls(opts: {
  bubble: HTMLElement
  line: ChatTextLine
  channelKey: string
  isSelf: boolean
}): HTMLElement | null {
  const { bubble, line, channelKey, isSelf } = opts
  const entry = chatTranslationService.get(line.id)
  const autoOn = chatTranslationSettings.getAutoTranslate(channelKey)
  const state = entry?.state ?? 'original'

  const wrap = document.createElement('div')
  wrap.className = 'chat-translate'
  wrap.dataset.state = state
  wrap.dataset.auto = autoOn ? '1' : '0'

  // Match Unity visibility: pending always; own messages only after finish+hover;
  // auto-on → hover only; auto-off → success/failed always, original on hover.
  let alwaysVisible = false
  if (state === 'pending') alwaysVisible = true
  else if (isSelf) alwaysVisible = false
  else if (autoOn) alwaysVisible = false
  else alwaysVisible = state === 'success' || state === 'failed'

  if (alwaysVisible) wrap.classList.add('is-always')

  if (state === 'pending') {
    const spin = document.createElement('span')
    spin.className = 'chat-translate__spinner'
    spin.setAttribute('aria-label', 'Translating')
    wrap.appendChild(spin)
  } else if (state === 'success' && entry && !entry.showingOriginal && entry.translatedText) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chat-translate__btn'
    btn.textContent = 'See original'
    btn.title = 'Show original message'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      chatTranslationService.revertToOriginal(line.id)
    })
    wrap.appendChild(btn)
  } else {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'chat-translate__btn'
    btn.textContent = state === 'failed' ? 'Retry translate' : 'Translate'
    btn.title =
      state === 'failed'
        ? entry?.error
          ? `Translation failed: ${entry.error}`
          : 'Translation failed — retry'
        : 'Translate message'
    btn.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      void chatTranslationService.translateManual(line.id, line.text)
    })
    wrap.appendChild(btn)
    if (state === 'failed') {
      const fail = document.createElement('span')
      fail.className = 'chat-translate__failed'
      fail.textContent = '!'
      fail.title = entry?.error ?? 'Translation failed'
      wrap.appendChild(fail)
    }
  }

  bubble.appendChild(wrap)
  return wrap
}

/** Label for the per-channel auto-translate control. */
export function autoTranslateButtonLabel(channelKey: string): string {
  return chatTranslationSettings.getAutoTranslate(channelKey)
    ? 'Auto-translate: On'
    : 'Auto-translate: Off'
}

/**
 * Wire a header auto-translate toggle. `getChannelKey` is read on each click/sync
 * so the same button can track channel switches.
 */
export function wireAutoTranslateToggle(
  btn: HTMLButtonElement,
  getChannelKey: () => string,
  onChange?: (enabled: boolean) => void
): void {
  const sync = (): void => {
    const channelKey = getChannelKey()
    const on = chatTranslationSettings.getAutoTranslate(channelKey)
    btn.classList.toggle('is-on', on)
    btn.setAttribute('aria-pressed', on ? 'true' : 'false')
    btn.title = on
      ? 'Auto-translate is on for this channel — click to turn off'
      : 'Auto-translate is off — click to translate new messages automatically'
    btn.textContent = on ? '文 A' : 'A 文'
  }
  if (btn.dataset.translateWired === '1') {
    sync()
    return
  }
  btn.dataset.translateWired = '1'
  sync()
  btn.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    const next = chatTranslationSettings.toggleAutoTranslate(getChannelKey())
    sync()
    onChange?.(next)
  })
  // Expose sync for channel changes without rebinding.
  ;(btn as HTMLButtonElement & { __syncAutoTranslate?: () => void }).__syncAutoTranslate = sync
}

export function syncAutoTranslateToggle(btn: HTMLButtonElement | null): void {
  const sync = (btn as HTMLButtonElement & { __syncAutoTranslate?: () => void } | null)
    ?.__syncAutoTranslate
  sync?.()
}

export function translationHint(entry: MessageTranslation | undefined): string | null {
  if (!entry || entry.state !== 'success' || entry.showingOriginal) return null
  if (!entry.detectedLanguage) return 'Translated'
  return `Translated from ${entry.detectedLanguage.toUpperCase()}`
}
