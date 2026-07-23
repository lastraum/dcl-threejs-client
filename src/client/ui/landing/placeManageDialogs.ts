/**
 * In-app confirm / form dialogs for Manage place (replaces window.prompt / confirm).
 */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export type PlaceManageDialogField = {
  name: string
  label: string
  type?: 'text' | 'textarea' | 'password'
  placeholder?: string
  value?: string
  required?: boolean
  rows?: number
  monospaced?: boolean
  /** Return error string to block submit. */
  validate?: (value: string, values: Record<string, string>) => string | null
}

export type PlaceManagePromptOptions = {
  title: string
  message?: string
  fields: PlaceManageDialogField[]
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

export type PlaceManageConfirmOptions = {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  danger?: boolean
}

function fieldHtml(field: PlaceManageDialogField): string {
  const id = `pm-dlg-${escapeHtml(field.name)}`
  const value = escapeHtml(field.value ?? '')
  const ph = escapeHtml(field.placeholder ?? '')
  const mono = field.monospaced ? ' place-manage-dialog-input--mono' : ''
  const required = field.required ? ' required' : ''
  if (field.type === 'textarea') {
    const rows = field.rows ?? 6
    return `
      <label class="place-manage-dialog-field" for="${id}">
        <span class="place-manage-dialog-label">${escapeHtml(field.label)}</span>
        <textarea id="${id}" class="place-manage-dialog-input place-manage-dialog-textarea${mono}"
          name="${escapeHtml(field.name)}" rows="${rows}" placeholder="${ph}"${required}>${value}</textarea>
      </label>`
  }
  const type = field.type === 'password' ? 'password' : 'text'
  return `
    <label class="place-manage-dialog-field" for="${id}">
      <span class="place-manage-dialog-label">${escapeHtml(field.label)}</span>
      <input id="${id}" class="place-manage-dialog-input${mono}" type="${type}"
        name="${escapeHtml(field.name)}" value="${value}" placeholder="${ph}" autocomplete="off"${required} />
    </label>`
}

function mountDialogShell(opts: {
  title: string
  message?: string
  bodyHtml: string
  confirmLabel: string
  cancelLabel: string
  danger?: boolean
}): {
  root: HTMLElement
  form: HTMLFormElement
  errorEl: HTMLElement
  confirmBtn: HTMLButtonElement
  dispose: () => void
} {
  const root = document.createElement('div')
  root.className = 'place-manage-dialog-backdrop'
  root.dataset.placeManageDialog = ''
  const confirmCls = opts.danger
    ? 'scene-stream-access-modal-btn scene-stream-access-modal-btn--danger place-manage-dialog-confirm'
    : 'scene-stream-access-modal-btn scene-stream-access-modal-btn--primary place-manage-dialog-confirm'
  root.innerHTML = `
    <div class="place-manage-dialog" role="dialog" aria-modal="true" aria-labelledby="place-manage-dialog-title">
      <h4 id="place-manage-dialog-title" class="place-manage-dialog-title">${escapeHtml(opts.title)}</h4>
      ${
        opts.message
          ? `<p class="place-manage-dialog-message">${escapeHtml(opts.message)}</p>`
          : ''
      }
      <form class="place-manage-dialog-form" data-dialog-form>
        ${opts.bodyHtml}
        <p class="place-manage-dialog-error" data-dialog-error hidden></p>
        <div class="place-manage-dialog-actions">
          <button type="button" class="scene-stream-access-modal-btn" data-dialog-cancel>${escapeHtml(opts.cancelLabel)}</button>
          <button type="submit" class="${confirmCls}" data-dialog-confirm>${escapeHtml(opts.confirmLabel)}</button>
        </div>
      </form>
    </div>
  `
  document.body.appendChild(root)
  const form = root.querySelector('[data-dialog-form]') as HTMLFormElement
  const errorEl = root.querySelector('[data-dialog-error]') as HTMLElement
  const confirmBtn = root.querySelector('[data-dialog-confirm]') as HTMLButtonElement
  const dispose = () => root.remove()
  return { root, form, errorEl, confirmBtn, dispose }
}

function setDialogError(el: HTMLElement, msg: string | null): void {
  if (!msg) {
    el.hidden = true
    el.textContent = ''
    return
  }
  el.hidden = false
  el.textContent = msg
}

/** Multi-field form dialog. Resolves values or null if cancelled. */
export function placeManagePrompt(
  opts: PlaceManagePromptOptions
): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    const bodyHtml = opts.fields.map(fieldHtml).join('')
    const { root, form, errorEl, dispose } = mountDialogShell({
      title: opts.title,
      message: opts.message,
      bodyHtml,
      confirmLabel: opts.confirmLabel ?? 'Save',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      danger: opts.danger
    })

    let settled = false
    const finish = (value: Record<string, string> | null) => {
      if (settled) return
      settled = true
      dispose()
      window.removeEventListener('keydown', onKey)
      resolve(value)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(null)
      }
    }
    window.addEventListener('keydown', onKey, true)

    root.addEventListener('click', (e) => {
      if (e.target === root) finish(null)
    })
    root.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => finish(null))

    form.addEventListener('submit', (e) => {
      e.preventDefault()
      const values: Record<string, string> = {}
      for (const field of opts.fields) {
        const el = form.elements.namedItem(field.name) as
          | HTMLInputElement
          | HTMLTextAreaElement
          | null
        values[field.name] = (el?.value ?? '').trim()
        if (field.required && !values[field.name]) {
          setDialogError(errorEl, `${field.label} is required.`)
          el?.focus()
          return
        }
      }
      for (const field of opts.fields) {
        if (!field.validate) continue
        const err = field.validate(values[field.name] ?? '', values)
        if (err) {
          setDialogError(errorEl, err)
          const el = form.elements.namedItem(field.name) as HTMLElement | null
          el?.focus()
          return
        }
      }
      setDialogError(errorEl, null)
      finish(values)
    })

    const first = form.querySelector<HTMLElement>('input, textarea')
    queueMicrotask(() => first?.focus())
  })
}

/** Confirm dialog. Resolves true if confirmed. */
export function placeManageConfirm(opts: PlaceManageConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    const { root, form, dispose } = mountDialogShell({
      title: opts.title,
      message: opts.message,
      bodyHtml: '',
      confirmLabel: opts.confirmLabel ?? 'Confirm',
      cancelLabel: opts.cancelLabel ?? 'Cancel',
      danger: opts.danger ?? true
    })

    let settled = false
    const finish = (value: boolean) => {
      if (settled) return
      settled = true
      dispose()
      window.removeEventListener('keydown', onKey)
      resolve(value)
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        finish(false)
      }
    }
    window.addEventListener('keydown', onKey, true)

    root.addEventListener('click', (e) => {
      if (e.target === root) finish(false)
    })
    root.querySelector('[data-dialog-cancel]')?.addEventListener('click', () => finish(false))
    form.addEventListener('submit', (e) => {
      e.preventDefault()
      finish(true)
    })
    queueMicrotask(() => {
      ;(root.querySelector('[data-dialog-confirm]') as HTMLButtonElement | null)?.focus()
    })
  })
}
