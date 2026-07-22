import { worldDisplayName, type WorldMapEntry } from '../../../map/worldsCatalog'

export type MapWorldPopupOptions = {
  mountEl: HTMLElement
  onClose: () => void
  onJumpIn: (worldName: string) => void
}

/** Bottom sheet world info — mirrors MapParcelPopup for the Worlds map / space views. */
export class MapWorldPopup {
  readonly root: HTMLElement
  private readonly onClose: () => void
  private readonly onJumpIn: (worldName: string) => void
  private world: WorldMapEntry | null = null

  constructor({ mountEl, onClose, onJumpIn }: MapWorldPopupOptions) {
    this.onClose = onClose
    this.onJumpIn = onJumpIn

    this.root = document.createElement('div')
    this.root.className = 'dcl-map__parcel-popup-backdrop dcl-map__world-popup-backdrop'
    this.root.hidden = true
    this.root.addEventListener('click', () => this.onClose())

    mountEl.appendChild(this.root)
  }

  showWorld(world: WorldMapEntry): void {
    this.world = world
    this.render()
    this.root.hidden = false
  }

  hide(): void {
    this.root.hidden = true
  }

  isVisible(): boolean {
    return !this.root.hidden
  }

  dispose(): void {
    this.root.remove()
  }

  private render(): void {
    const world = this.world
    if (!world) {
      this.root.innerHTML = ''
      return
    }

    const title = worldDisplayName(world)
    const usersLine =
      world.users > 0
        ? `<p class="dcl-map__parcel-popup-coords"><span aria-hidden>🟢</span> ${world.users} online</p>`
        : `<p class="dcl-map__parcel-popup-coords"><span aria-hidden>🌐</span> ${escapeHtml(world.worldName)}</p>`

    const metaBits: string[] = []
    if (world.categories?.length) metaBits.push(world.categories.slice(0, 3).join(' · '))
    if (typeof world.likes === 'number' && world.likes > 0) metaBits.push(`${world.likes} likes`)
    if (typeof world.favorites === 'number' && world.favorites > 0)
      metaBits.push(`${world.favorites} favorites`)
    const meta =
      metaBits.length > 0
        ? `<p class="dcl-map__parcel-popup-meta">${escapeHtml(metaBits.join(' · '))}</p>`
        : ''

    const desc = world.description?.trim()
      ? `<p class="dcl-map__parcel-popup-desc">${escapeHtml(world.description.trim())}</p>`
      : ''

    const imageSrc = world.imageUrl

    this.root.innerHTML = `
      <div class="dcl-map__parcel-popup dcl-map__world-popup" role="dialog" aria-labelledby="dcl-world-popup-title">
        <button type="button" class="dcl-map__parcel-popup-close" aria-label="Close">&times;</button>
        <div class="dcl-map__parcel-popup-preview">
          ${
            imageSrc
              ? `<img src="${escapeAttr(imageSrc)}" alt="" decoding="async" />`
              : `<div class="dcl-map__parcel-popup-preview-fallback dcl-map__world-popup-fallback" aria-hidden>
                   <span>${escapeHtml(title.charAt(0).toUpperCase() || 'W')}</span>
                 </div>`
          }
        </div>
        <div class="dcl-map__parcel-popup-body">
          ${usersLine}
          <h2 id="dcl-world-popup-title" class="dcl-map__parcel-popup-name">${escapeHtml(title)}</h2>
          <p class="dcl-map__world-popup-urn">${escapeHtml(world.worldName)}</p>
          ${meta}
          ${desc}
          <button type="button" class="dcl-map__parcel-popup-jump dcl-map__world-popup-jump">Jump In</button>
        </div>
      </div>
    `

    this.root.querySelector('.dcl-map__parcel-popup-close')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.onClose()
    })

    this.root.querySelector('.dcl-map__parcel-popup')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
    })

    this.root.querySelector('.dcl-map__parcel-popup-jump')?.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.onJumpIn(world.worldName)
    })
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
