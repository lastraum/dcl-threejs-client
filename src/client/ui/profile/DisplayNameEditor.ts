import {
  DISPLAY_NAME_MAX_LEN,
  sanitizeDisplayName,
  validateDisplayName,
  type DisplayNameChoice
} from '../../../avatar/displayNameDeploy'

export type DisplayNameEditorOptions = {
  currentName: string
  /** Owned DCL name, if any — enables “Use DCL name”. */
  claimedName: string | null
  hasClaimedName: boolean
  onSave: (choice: DisplayNameChoice) => Promise<void>
}

/**
 * Compact inline name editor for the 2D profile card, settings header, and
 * self passport. Callers own Catalyst deploy + comms announce.
 */
export class DisplayNameEditor {
  readonly root: HTMLElement
  private readonly input: HTMLInputElement
  private readonly status: HTMLElement
  private readonly saveBtn: HTMLButtonElement
  private readonly claimedCheck: HTMLInputElement | null
  private saving = false

  constructor(private readonly options: DisplayNameEditorOptions) {
    this.root = document.createElement('div')
    this.root.className = 'display-name-editor'
    const claimed = options.claimedName?.trim() || ''
    const useClaimed = options.hasClaimedName && !!claimed

    this.root.innerHTML = `
      ${
        claimed
          ? `<label class="display-name-editor__claimed">
              <input type="checkbox" data-claimed ${useClaimed ? 'checked' : ''} />
              Use DCL name <strong>${escapeHtml(claimed)}</strong>
            </label>`
          : ''
      }
      <div class="display-name-editor__row">
        <input
          type="text"
          class="display-name-editor__input"
          maxlength="${DISPLAY_NAME_MAX_LEN}"
          spellcheck="false"
          autocomplete="nickname"
          placeholder="Display name"
          value="${escapeHtml(options.currentName)}"
          ${useClaimed ? 'disabled' : ''}
        />
        <button type="button" class="display-name-editor__save">Save</button>
      </div>
      <p class="display-name-editor__status" role="status"></p>
    `

    this.input = this.root.querySelector('.display-name-editor__input')!
    this.status = this.root.querySelector('.display-name-editor__status')!
    this.saveBtn = this.root.querySelector('.display-name-editor__save')!
    this.claimedCheck = this.root.querySelector('[data-claimed]')

    this.claimedCheck?.addEventListener('change', () => {
      const on = this.claimedCheck!.checked
      this.input.disabled = on
      if (on && claimed) this.input.value = claimed
    })
    this.saveBtn.addEventListener('click', () => void this.save())
    this.input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault()
        void this.save()
      }
      ev.stopPropagation()
    })
  }

  dispose(): void {
    this.root.remove()
  }

  private setStatus(msg: string, kind: 'idle' | 'busy' | 'error' | 'ok' = 'idle'): void {
    this.status.textContent = msg
    this.status.dataset.kind = kind
  }

  private async save(): Promise<void> {
    if (this.saving) return
    const useClaimed = !!this.claimedCheck?.checked
    const choice: DisplayNameChoice = useClaimed
      ? { mode: 'claimed' }
      : { mode: 'custom', name: this.input.value }
    if (choice.mode === 'custom') {
      const err = validateDisplayName(choice.name)
      if (err) {
        this.setStatus(err, 'error')
        return
      }
      this.input.value = sanitizeDisplayName(choice.name)
    }
    this.saving = true
    this.saveBtn.disabled = true
    this.setStatus('Saving…', 'busy')
    try {
      await this.options.onSave(choice)
      this.setStatus('Saved', 'ok')
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : 'Could not save name', 'error')
    } finally {
      this.saving = false
      this.saveBtn.disabled = false
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
