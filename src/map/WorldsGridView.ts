/**
 * Explorer-style scrollable worlds grid (same card size / columns as Places explorer).
 * Worlds-only catalog, A–Z by default when set from map catalog.
 */
import { worldDisplayName, type WorldMapEntry } from './worldsCatalog'

export type WorldsGridViewOptions = {
  onSelectWorld?: (worldName: string) => void
}

/**
 * Flat atlas of world cards — CSS grid matching Explorer Places, scrollable.
 */
export class WorldsGridView {
  readonly root: HTMLDivElement
  private readonly gridEl: HTMLDivElement
  private readonly emptyEl: HTMLParagraphElement
  private readonly onSelectWorld?: (worldName: string) => void

  private active = false
  private disposed = false
  private entries: WorldMapEntry[] = []
  private focusedKey: string | null = null

  constructor(opts: WorldsGridViewOptions = {}) {
    this.onSelectWorld = opts.onSelectWorld

    this.root = document.createElement('div')
    // places-view--explorer pulls in Explorer card chrome; avoid places-view__results
    // (that sets overflow:visible / flex:none and breaks scrolling in the map shell).
    this.root.className = 'dcl-map__worlds-grid places-view places-view--explorer'
    this.root.hidden = true
    this.root.setAttribute('aria-label', 'Worlds map grid')

    const results = document.createElement('div')
    results.className = 'dcl-map__worlds-grid-scroll'

    this.gridEl = document.createElement('div')
    this.gridEl.className = 'places-view__grid dcl-map__worlds-grid-list'
    this.gridEl.setAttribute('role', 'list')

    this.emptyEl = document.createElement('p')
    this.emptyEl.className = 'dcl-map__worlds-grid-empty'
    this.emptyEl.hidden = true
    this.emptyEl.textContent = 'Loading worlds…'

    results.append(this.gridEl, this.emptyEl)
    this.root.appendChild(results)

    this.gridEl.addEventListener('click', this.onGridClick)
  }

  setActive(active: boolean): void {
    if (this.disposed) return
    this.active = active
    this.root.hidden = !active
  }

  isActive(): boolean {
    return this.active
  }

  resize(_w: number, _h: number): void {
    /* CSS grid is fluid — no absolute layout. */
  }

  setWorlds(entries: WorldMapEntry[]): void {
    if (this.disposed) return
    // A–Z by display title, then worldName.
    this.entries = [...entries].sort((a, b) => {
      const an = worldDisplayName(a)
      const bn = worldDisplayName(b)
      const byLabel = an.localeCompare(bn, undefined, { sensitivity: 'base' })
      if (byLabel !== 0) return byLabel
      return a.worldName.localeCompare(b.worldName, undefined, { sensitivity: 'base' })
    })
    this.render()
  }

  focusWorld(worldName: string): void {
    const key = worldName.toLowerCase()
    this.focusedKey = key
    this.gridEl.querySelectorAll<HTMLElement>('[data-world]').forEach((el) => {
      el.classList.toggle('is-focused', el.dataset.world?.toLowerCase() === key)
    })
    const card = this.gridEl.querySelector<HTMLElement>(`[data-world="${CSS.escape(worldName)}"]`)
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
    this.onSelectWorld?.(worldName)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.active = false
    this.gridEl.removeEventListener('click', this.onGridClick)
    this.root.remove()
  }

  private render(): void {
    if (!this.entries.length) {
      this.gridEl.innerHTML = ''
      this.emptyEl.hidden = false
      this.emptyEl.textContent = 'No worlds found'
      return
    }
    this.emptyEl.hidden = true
    this.gridEl.innerHTML = this.entries.map((e) => this.cardHtml(e)).join('')
  }

  private cardHtml(entry: WorldMapEntry): string {
    const title = worldDisplayName(entry)
    const location = entry.worldName
    const thumb = entry.imageUrl
    const focused = this.focusedKey === entry.worldName.toLowerCase()
    const crowd =
      entry.users > 0
        ? `
          <span class="places-view__crowd-pill" aria-label="${entry.users} people here">
            <span class="places-view__crowd-pill-dot" aria-hidden="true"></span>
            <svg class="places-view__crowd-pill-icon" viewBox="0 0 24 24" width="12" height="12" aria-hidden="true">
              <path fill="currentColor" d="M12 12a4 4 0 1 0-4-4 4 4 0 0 0 4 4zm0 2c-3.31 0-6 1.57-6 3.5V19h12v-1.5C18 15.57 15.31 14 12 14z"/>
            </svg>
            ${entry.users}
          </span>`
        : ''

    const topBadges = crowd
      ? `<div class="places-view__live-top"><span></span>${crowd}</div>`
      : ''

    return `
      <article
        class="places-view__card places-view__card--grid${focused ? ' is-focused' : ''}"
        role="listitem"
        data-world="${escapeAttr(entry.worldName)}"
        tabindex="0"
      >
        <div class="places-view__card-media">
          ${
            thumb
              ? `<img class="places-view__card-img" src="${escapeAttr(thumb)}" alt="" loading="lazy" decoding="async" />`
              : `<div class="places-view__card-placeholder" aria-hidden>
                   <span class="dcl-map__worlds-grid-letter">${escapeHtml(title.charAt(0).toUpperCase() || 'W')}</span>
                 </div>`
          }
          ${topBadges}
        </div>
        <div class="places-view__card-body places-view__card-body--grid">
          <h3 class="places-view__card-title">${escapeHtml(title)}</h3>
          <div class="places-view__card-action">
            <div class="places-view__card-footer places-view__card-footer--live">
              <span class="places-view__card-location" title="${escapeAttr(location)}">${escapeHtml(location)}</span>
            </div>
            <button type="button" class="places-view__card-visit" data-jump="${escapeAttr(entry.worldName)}">View</button>
          </div>
        </div>
      </article>
    `
  }

  private onGridClick = (ev: MouseEvent): void => {
    const t = ev.target
    if (!(t instanceof Element)) return
    const jump = t.closest<HTMLElement>('[data-jump]')
    if (jump?.dataset.jump) {
      ev.preventDefault()
      ev.stopPropagation()
      this.focusWorld(jump.dataset.jump)
      return
    }
    const card = t.closest<HTMLElement>('[data-world]')
    if (card?.dataset.world) {
      this.focusWorld(card.dataset.world)
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

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/'/g, '&#39;')
}
