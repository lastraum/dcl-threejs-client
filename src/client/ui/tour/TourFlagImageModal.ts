/**
 * Centered image dropper for tour flag banner (enable flag flow).
 */
import {
  isAllowedFollowFlagFile,
  prepareFollowFlagImage
} from '../../../social/prepareFollowFlagImage'

export type TourFlagImageModalOptions = {
  onPicked: (dataUrl: string) => void | Promise<void>
  onCancel: () => void
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export class TourFlagImageModal {
  readonly root: HTMLElement
  private readonly opts: TourFlagImageModalOptions
  private disposed = false
  private busy = false

  constructor(opts: TourFlagImageModalOptions) {
    this.opts = opts
    this.root = document.createElement('div')
    this.root.className = 'tour-flag-image-modal-host'
    this.root.innerHTML = `
      <div class="tour-flag-image-modal-backdrop" data-tour-flag-backdrop role="presentation">
        <div class="tour-flag-image-modal" role="dialog" aria-modal="true" aria-labelledby="tour-flag-image-title">
          <h3 id="tour-flag-image-title" class="tour-flag-image-title">Tour flag image</h3>
          <p class="tour-flag-image-hint">Drop an image or click to choose. It appears on your spine flag pole for followers.</p>
          <label class="tour-flag-image-drop" data-tour-flag-drop>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif,.jpg,.jpeg,.png,.webp,.gif"
              class="tour-flag-image-input" data-tour-flag-input hidden />
            <span class="tour-flag-image-drop-icon" aria-hidden>🚩</span>
            <span class="tour-flag-image-drop-label" data-tour-flag-drop-label>Drop image here or click to browse</span>
          </label>
          <p class="tour-flag-image-error" data-tour-flag-error hidden></p>
          <div class="tour-flag-image-actions">
            <button type="button" class="tour-flag-image-btn tour-flag-image-btn--ghost" data-tour-flag-cancel>Cancel</button>
          </div>
        </div>
      </div>
    `
    this.bind()
    document.body.appendChild(this.root)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.root.remove()
  }

  private bind(): void {
    this.root.querySelector('[data-tour-flag-backdrop]')?.addEventListener('click', (e) => {
      if (e.target === e.currentTarget) this.opts.onCancel()
    })
    this.root.querySelector('[data-tour-flag-cancel]')?.addEventListener('click', () => {
      this.opts.onCancel()
    })
    const drop = this.root.querySelector('[data-tour-flag-drop]') as HTMLElement
    const input = this.root.querySelector('[data-tour-flag-input]') as HTMLInputElement
    drop.addEventListener('click', () => {
      if (!this.busy) input.click()
    })
    drop.addEventListener('dragover', (e) => {
      e.preventDefault()
      drop.classList.add('is-dragover')
    })
    drop.addEventListener('dragleave', () => drop.classList.remove('is-dragover'))
    drop.addEventListener('drop', (e) => {
      e.preventDefault()
      drop.classList.remove('is-dragover')
      const file = e.dataTransfer?.files?.[0]
      if (file) void this.handleFile(file)
    })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      input.value = ''
      if (file) void this.handleFile(file)
    })
  }

  private setError(msg: string | null): void {
    const el = this.root.querySelector('[data-tour-flag-error]') as HTMLElement
    if (!msg) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.textContent = msg
  }

  private async handleFile(file: File): Promise<void> {
    if (this.busy || this.disposed) return
    if (!isAllowedFollowFlagFile(file)) {
      this.setError('Use JPEG, PNG, WebP, or GIF')
      return
    }
    this.busy = true
    this.setError(null)
    const label = this.root.querySelector('[data-tour-flag-drop-label]') as HTMLElement
    label.textContent = 'Processing…'
    try {
      const dataUrl = await prepareFollowFlagImage(file)
      if (this.disposed) return
      await this.opts.onPicked(dataUrl)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Could not process image'
      this.setError(escapeHtml(msg))
      label.textContent = 'Drop image here or click to browse'
    } finally {
      this.busy = false
    }
  }
}
