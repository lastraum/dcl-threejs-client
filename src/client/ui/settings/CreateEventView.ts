import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { DclEvent } from '../../../social/dclEvents'
import {
  combineDateAndTimeIso,
  createDclEvent,
  parseDurationMs,
  uploadEventPoster,
  type CreateEventPayload
} from '../../../social/dclEventsCreate'
import { fetchMemberCommunitiesSigned } from '../../../social/socialApi'

import { routePathForWorld } from '../../../dcl/content/route'

const MAX_POSTER_BYTES = 500 * 1024
const HORIZONTAL_HINT = '1340×670px · PNG, JPG, or GIF · max 500KB'
const VERTICAL_HINT = '716×1814px · PNG, JPG, or WebP · max 500KB'

export type CreateEventViewOptions = {
  identity: AuthIdentity
  defaultCoords?: { x: number; y: number } | null
  isWorldScene?: boolean
  worldName?: string | null
  onCancel: () => void
  onCreated: (event: DclEvent) => void
  onToast: (message: string) => void
}

type LocationKind = 'land' | 'world'

export class CreateEventView {
  readonly root: HTMLElement

  private readonly opts: CreateEventViewOptions
  private coverFile: File | null = null
  private coverVerticalFile: File | null = null
  private coverPreviewUrl: string | null = null
  private submitting = false

  constructor(opts: CreateEventViewOptions) {
    this.opts = opts

    const defaultX = opts.defaultCoords?.x ?? 0
    const defaultY = opts.defaultCoords?.y ?? 0
    const defaultWorld = opts.isWorldScene ?? false
    const today = new Date().toISOString().slice(0, 10)

    this.root = document.createElement('div')
    this.root.className = 'create-event-view'
    this.root.innerHTML = `
      <header class="create-event-view__header">
        <button type="button" class="create-event-view__back" data-cancel aria-label="Back">←</button>
        <h2 class="create-event-view__title">Submit a Hangout</h2>
      </header>

      <form class="create-event-view__form" novalidate>
        <div class="create-event-view__layout">
          <section class="create-event-view__main">
            <div class="create-event-view__dropzone" data-dropzone>
              <input type="file" class="create-event-view__file-input" data-cover-input accept="image/png,image/jpeg,image/gif,image/webp" hidden />
              <div class="create-event-view__dropzone-inner" data-dropzone-inner>
                <span class="create-event-view__dropzone-icon" aria-hidden="true">📷</span>
                <p class="create-event-view__dropzone-title">Select a Hangout Cover</p>
                <p class="create-event-view__dropzone-hint">Choose a picture from your gallery or drop it here</p>
                <p class="create-event-view__dropzone-size">(recommended size: 1340 x 670)</p>
              </div>
              <img class="create-event-view__cover-preview" data-cover-preview hidden alt="" />
            </div>
            <p class="create-event-view__upload-note">${HORIZONTAL_HINT}. Center visuals and text to fit all screen resolutions.</p>
            <button type="button" class="create-event-view__add-vertical" data-toggle-vertical>+ Add Vertical Cover (recommended)</button>
            <div class="create-event-view__vertical-block" data-vertical-block hidden>
              <div class="create-event-view__dropzone create-event-view__dropzone--vertical" data-vertical-dropzone>
                <input type="file" class="create-event-view__file-input" data-vertical-cover-input accept="image/png,image/jpeg,image/webp" hidden />
                <div class="create-event-view__dropzone-inner">
                  <p class="create-event-view__dropzone-title">Vertical cover</p>
                  <p class="create-event-view__dropzone-hint">${VERTICAL_HINT}</p>
                </div>
                <img class="create-event-view__cover-preview create-event-view__cover-preview--vertical" data-vertical-preview hidden alt="" />
              </div>
            </div>

            <label class="create-event-view__field">
              <span class="create-event-view__label">Hangout name</span>
              <input class="create-event-view__input" name="name" maxlength="150" placeholder="Be as descriptive as you can" required />
            </label>
            <label class="create-event-view__field">
              <span class="create-event-view__label">Hangout description</span>
              <textarea class="create-event-view__textarea" name="description" maxlength="5000" rows="5" placeholder="Be as descriptive as you can"></textarea>
            </label>
          </section>

          <aside class="create-event-view__aside">
            <h3 class="create-event-view__aside-title">Hangout details</h3>
            <label class="create-event-view__field">
              <span class="create-event-view__label">Date</span>
              <input class="create-event-view__input" type="date" name="date" value="${today}" required />
            </label>
            <label class="create-event-view__field">
              <span class="create-event-view__label">Start</span>
              <input class="create-event-view__input" type="time" name="start" required />
            </label>
            <label class="create-event-view__field">
              <span class="create-event-view__label">Duration</span>
              <input class="create-event-view__input" type="text" name="duration" placeholder="hh:mm" pattern="\\d{1,2}:\\d{2}" required />
            </label>

            <label class="create-event-view__toggle-row">
              <span>Repeat hangout</span>
              <input type="checkbox" name="recurrent" />
            </label>
            <label class="create-event-view__field" data-recur-field hidden>
              <span class="create-event-view__label">Repeats</span>
              <select class="create-event-view__input" name="recurrent_frequency">
                <option value="DAILY">Daily</option>
                <option value="WEEKLY">Weekly</option>
                <option value="MONTHLY">Monthly</option>
              </select>
            </label>

            <h3 class="create-event-view__aside-title">Location</h3>
            <label class="create-event-view__field">
              <span class="create-event-view__label">Location type</span>
              <select class="create-event-view__input" name="location_kind">
                <option value="land"${defaultWorld ? '' : ' selected'}>Land</option>
                <option value="world"${defaultWorld ? ' selected' : ''}>World</option>
              </select>
            </label>
            <div class="create-event-view__coords" data-land-coords>
              <label class="create-event-view__field">
                <span class="create-event-view__label">Latitude (X)</span>
                <input class="create-event-view__input" type="number" name="x" min="-170" max="170" value="${defaultX}" required />
              </label>
              <label class="create-event-view__field">
                <span class="create-event-view__label">Longitude (Y)</span>
                <input class="create-event-view__input" type="number" name="y" min="-170" max="170" value="${defaultY}" required />
              </label>
            </div>
            <label class="create-event-view__field" data-world-field hidden>
              <span class="create-event-view__label">World name</span>
              <input class="create-event-view__input" name="world_name" placeholder="name.dcl.eth" value="${opts.worldName?.trim() ?? ''}" />
            </label>

            <label class="create-event-view__field">
              <span class="create-event-view__label">Community</span>
              <select class="create-event-view__input" name="community_id" data-community-select>
                <option value="">None</option>
              </select>
            </label>
            <label class="create-event-view__field">
              <span class="create-event-view__label">Email (optional)</span>
              <input class="create-event-view__input" type="email" name="contact" placeholder="hello@example.com" maxlength="100" />
            </label>
            <p class="create-event-view__review-note">The hangout submission will be reviewed by our team — you'll be notified by email.</p>
          </aside>
        </div>

        <footer class="create-event-view__footer">
          <button type="button" class="create-event-view__btn create-event-view__btn--ghost" data-preview>Preview</button>
          <button type="button" class="create-event-view__btn create-event-view__btn--ghost" data-cancel>Cancel</button>
          <button type="submit" class="create-event-view__btn create-event-view__btn--primary" data-submit>Submit Hangout</button>
        </footer>
        <p class="create-event-view__error" data-error hidden></p>
      </form>
    `

    this.bindEvents()
    void this.loadCommunities()
    this.syncLocationFields()
  }

  dispose(): void {
    if (this.coverPreviewUrl) URL.revokeObjectURL(this.coverPreviewUrl)
    this.root.remove()
  }

  private bindEvents(): void {
    const form = this.root.querySelector('form')!
    form.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.submit()
    })

    this.root.querySelectorAll('[data-cancel]').forEach((el) => {
      el.addEventListener('click', () => this.opts.onCancel())
    })

    this.root.querySelector('[data-preview]')!.addEventListener('click', () => this.showPreview())

    const recurrent = form.querySelector<HTMLInputElement>('input[name="recurrent"]')!
    const recurField = this.root.querySelector('[data-recur-field]') as HTMLElement
    recurrent.addEventListener('change', () => {
      recurField.hidden = !recurrent.checked
    })

    const locationKind = form.querySelector<HTMLSelectElement>('select[name="location_kind"]')!
    locationKind.addEventListener('change', () => this.syncLocationFields())

    this.root.querySelector('[data-toggle-vertical]')!.addEventListener('click', () => {
      const block = this.root.querySelector('[data-vertical-block]') as HTMLElement
      block.hidden = false
      this.root.querySelector('[data-toggle-vertical]')!.remove()
    })

    this.setupDropzone(
      this.root.querySelector('[data-dropzone]')!,
      this.root.querySelector('[data-cover-input]')! as HTMLInputElement,
      this.root.querySelector('[data-cover-preview]')! as HTMLImageElement,
      false
    )
    this.setupDropzone(
      this.root.querySelector('[data-vertical-dropzone]')!,
      this.root.querySelector('[data-vertical-cover-input]')! as HTMLInputElement,
      this.root.querySelector('[data-vertical-preview]')! as HTMLImageElement,
      true
    )
  }

  private setupDropzone(
    zone: Element,
    input: HTMLInputElement,
    preview: HTMLImageElement,
    vertical: boolean
  ): void {
    const pick = () => input.click()
    zone.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('input')) return
      pick()
    })
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (file) this.setCoverFile(file, preview, zone as HTMLElement, vertical)
    })
    zone.addEventListener('dragover', (ev) => {
      ev.preventDefault()
      zone.classList.add('is-dragover')
    })
    zone.addEventListener('dragleave', () => zone.classList.remove('is-dragover'))
    zone.addEventListener('drop', (ev) => {
      ev.preventDefault()
      zone.classList.remove('is-dragover')
      const file = (ev as DragEvent).dataTransfer?.files?.[0]
      if (file) this.setCoverFile(file, preview, zone as HTMLElement, vertical)
    })
  }

  private setCoverFile(file: File, preview: HTMLImageElement, zone: HTMLElement, vertical: boolean): void {
    if (file.size > MAX_POSTER_BYTES) {
      this.setError(`Image must be under 500KB (${Math.round(file.size / 1024)}KB selected)`)
      return
    }
    if (vertical) this.coverVerticalFile = file
    else {
      this.coverFile = file
      if (this.coverPreviewUrl) URL.revokeObjectURL(this.coverPreviewUrl)
      this.coverPreviewUrl = URL.createObjectURL(file)
    }
    preview.src = URL.createObjectURL(file)
    preview.hidden = false
    zone.querySelector('[data-dropzone-inner], .create-event-view__dropzone-inner')?.classList.add('is-hidden')
    this.setError('')
  }

  private syncLocationFields(): void {
    const form = this.root.querySelector('form')!
    const kind = (form.querySelector('select[name="location_kind"]') as HTMLSelectElement).value as LocationKind
    const land = this.root.querySelector('[data-land-coords]') as HTMLElement
    const world = this.root.querySelector('[data-world-field]') as HTMLElement
    const isWorld = kind === 'world'
    land.hidden = isWorld
    world.hidden = !isWorld
  }

  private async loadCommunities(): Promise<void> {
    try {
      const { communities } = await fetchMemberCommunitiesSigned(this.opts.identity)
      const select = this.root.querySelector('[data-community-select]') as HTMLSelectElement
      for (const c of communities) {
        const opt = document.createElement('option')
        opt.value = c.id
        opt.textContent = c.name
        select.appendChild(opt)
      }
    } catch {
      // optional — form still works without communities
    }
  }

  private readForm(): { payload: CreateEventPayload | null; error: string } {
    const form = this.root.querySelector('form')!
    const fd = new FormData(form)
    const name = String(fd.get('name') ?? '').trim()
    const description = String(fd.get('description') ?? '').trim()
    const date = String(fd.get('date') ?? '')
    const start = String(fd.get('start') ?? '')
    const durationRaw = String(fd.get('duration') ?? '')
    const locationKind = String(fd.get('location_kind') ?? 'land') as LocationKind
    const x = Number(fd.get('x'))
    const y = Number(fd.get('y'))
    const worldName = String(fd.get('world_name') ?? '').trim()
    const contact = String(fd.get('contact') ?? '').trim()
    const communityId = String(fd.get('community_id') ?? '').trim()
    const recurrent = fd.get('recurrent') === 'on'
    const recurrentFrequency = String(fd.get('recurrent_frequency') ?? 'DAILY') as CreateEventPayload['recurrent_frequency']

    if (!name) return { payload: null, error: 'Hangout name is required' }
    const start_at = combineDateAndTimeIso(date, start)
    if (!start_at) return { payload: null, error: 'Valid date and start time are required' }
    const duration = parseDurationMs(durationRaw)
    if (duration === null) return { payload: null, error: 'Duration must be hh:mm (max 24 hours)' }

    const isWorld = locationKind === 'world'
    if (isWorld && !worldName) return { payload: null, error: 'World name is required for world hangouts' }
    if (!isWorld && (!Number.isFinite(x) || !Number.isFinite(y))) {
      return { payload: null, error: 'Valid parcel coordinates are required' }
    }

    const normalizedWorld = worldName.includes('.') ? worldName : `${worldName}.dcl.eth`
    const payload: CreateEventPayload = {
      name,
      description: description || null,
      start_at,
      duration,
      x: isWorld ? 0 : Math.round(x),
      y: isWorld ? 0 : Math.round(y),
      world: isWorld,
      contact: contact || null,
      community_id: communityId || null
    }

    if (isWorld) {
      payload.url = `${window.location.origin}${routePathForWorld(normalizedWorld)}`
    }

    if (recurrent) {
      payload.recurrent = true
      payload.recurrent_frequency = recurrentFrequency ?? 'DAILY'
      payload.recurrent_interval = 1
    }

    return { payload, error: '' }
  }

  private showPreview(): void {
    const { payload, error } = this.readForm()
    if (!payload) {
      this.setError(error)
      return
    }
    const lines = [
      payload.name,
      `Starts: ${new Date(payload.start_at).toLocaleString()}`,
      `Duration: ${Math.round(payload.duration / 60_000)} min`,
      payload.world ? `World: ${payload.url}` : `Land: ${payload.x}, ${payload.y}`,
      payload.recurrent ? `Repeats ${payload.recurrent_frequency?.toLowerCase()}` : 'One-time'
    ]
    this.opts.onToast(lines.join(' · '))
  }

  private setError(message: string): void {
    const el = this.root.querySelector('[data-error]') as HTMLElement
    if (!message) {
      el.hidden = true
      el.textContent = ''
      return
    }
    el.hidden = false
    el.textContent = message
  }

  private async submit(): Promise<void> {
    if (this.submitting) return
    const { payload, error } = this.readForm()
    if (!payload) {
      this.setError(error)
      return
    }

    this.submitting = true
    const submitBtn = this.root.querySelector('[data-submit]') as HTMLButtonElement
    submitBtn.disabled = true
    submitBtn.textContent = 'Submitting…'
    this.setError('')

    try {
      if (this.coverFile) {
        const uploaded = await uploadEventPoster(this.coverFile, this.opts.identity, false)
        payload.image = uploaded.url
      }
      if (this.coverVerticalFile) {
        const uploaded = await uploadEventPoster(this.coverVerticalFile, this.opts.identity, true)
        payload.image_vertical = uploaded.url
      }

      const created = await createDclEvent(payload, this.opts.identity)
      this.opts.onToast('Hangout submitted — pending review')
      this.opts.onCreated(created)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.setError(msg)
      this.opts.onToast(msg)
    } finally {
      this.submitting = false
      submitBtn.disabled = false
      submitBtn.textContent = 'Submit Hangout'
    }
  }
}