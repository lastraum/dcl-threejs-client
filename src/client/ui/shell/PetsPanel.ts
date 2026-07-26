import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  formatPetByteSize,
  addPetFile,
  listPetLibrary,
  removePetFromLibrary,
  updatePetLibraryCategory,
  updatePetLibraryMeshYaw
} from '../../../pets/PetLibrary'
import {
  getActivePetEntry,
  getPetInventory,
  removeOwnedPet,
  setActivePetHash,
  setOwnedPetCategory,
  setOwnedPetMeshYawOffset,
  setOwnedPetNickname,
  upsertOwnedPet
} from '../../../pets/petInventoryStorage'
import type { PetCategory, PetLibraryEntry } from '../../../pets/types'

export type PetsPanelOptions = {
  getSession: () => SessionIdentity
  /** Called when user enables / disables / changes category of active pet. */
  onActivePetChange?: () => void | Promise<void>
  onClose?: () => void
  anchor?: () => HTMLElement | undefined
}

/**
 * Sidebar Pets inventory — upload GLB, pick walking/flying, enable one pet.
 */
export class PetsPanel {
  readonly element: HTMLDivElement
  private visible = false
  private busy = false
  private uploadCategory: PetCategory = 'walking'
  private readonly bodyEl: HTMLElement
  private readonly statusEl: HTMLElement
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private readonly onDocClick: (ev: MouseEvent) => void
  private readonly onResize: () => void

  constructor(private readonly options: PetsPanelOptions) {
    this.element = document.createElement('div')
    this.element.id = 'pets-panel-wrap'
    this.element.className = 'pets-panel-wrap'
    this.element.hidden = true
    this.element.setAttribute('role', 'dialog')
    this.element.setAttribute('aria-label', 'Pets')
    this.element.innerHTML = `
      <div class="pets-panel">
        <header class="pets-panel__header">
          <h2 class="pets-panel__title">Pets</h2>
          <button type="button" class="pets-panel__close" data-close aria-label="Close">×</button>
        </header>
        <div class="pets-panel__upload">
          <div class="pets-panel__cat-row" role="group" aria-label="Upload category">
            <button type="button" class="pets-panel__cat is-active" data-upload-cat="walking">Walking</button>
            <button type="button" class="pets-panel__cat" data-upload-cat="flying">Flying</button>
          </div>
          <label class="pets-panel__upload-btn">
            Upload GLB
            <input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" hidden data-file />
          </label>
        </div>
        <p class="pets-panel__hint">One active pet. Walking stays near the ground; flying hovers above you. Models sync to nearby peers like custom avatars.</p>
        <p class="pets-panel__status" data-status hidden></p>
        <div class="pets-panel__body" data-body></div>
      </div>
    `
    this.bodyEl = this.element.querySelector('[data-body]')!
    this.statusEl = this.element.querySelector('[data-status]')!

    this.element.querySelector('[data-close]')!.addEventListener('click', () => this.hide())

    this.element.querySelectorAll<HTMLButtonElement>('[data-upload-cat]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const cat = btn.dataset.uploadCat === 'flying' ? 'flying' : 'walking'
        this.uploadCategory = cat
        this.element.querySelectorAll('[data-upload-cat]').forEach((b) => {
          b.classList.toggle('is-active', (b as HTMLElement).dataset.uploadCat === cat)
        })
      })
    })

    const fileInput = this.element.querySelector<HTMLInputElement>('[data-file]')!
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0]
      fileInput.value = ''
      if (file) void this.handleUpload(file)
    })

    this.bodyEl.addEventListener('click', (ev) => void this.onBodyClick(ev))
    this.bodyEl.addEventListener('change', (ev) => void this.onBodyChange(ev))

    this.onKeyDown = (ev) => {
      if (ev.key === 'Escape' && this.visible) this.hide()
    }
    this.onDocClick = (ev) => {
      if (!this.visible) return
      const t = ev.target as Node
      if (this.element.contains(t)) return
      const anchor = this.options.anchor?.()
      if (anchor?.contains(t)) return
      this.hide()
    }
    this.onResize = () => {
      if (this.visible) this.positionPanel()
    }

    document.body.appendChild(this.element)
  }

  dispose(): void {
    this.hide()
    this.element.remove()
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('click', this.onDocClick, true)
  }

  isVisible(): boolean {
    return this.visible
  }

  toggle(): void {
    if (this.visible) this.hide()
    else void this.show()
  }

  async show(): Promise<void> {
    this.visible = true
    this.element.hidden = false
    this.positionPanel()
    window.addEventListener('keydown', this.onKeyDown)
    window.addEventListener('resize', this.onResize)
    setTimeout(() => document.addEventListener('click', this.onDocClick, true), 0)
    await this.render()
  }

  hide(): void {
    if (!this.visible) return
    this.visible = false
    this.element.hidden = true
    window.removeEventListener('keydown', this.onKeyDown)
    window.removeEventListener('resize', this.onResize)
    document.removeEventListener('click', this.onDocClick, true)
    this.options.onClose?.()
  }

  async refresh(): Promise<void> {
    if (this.visible) await this.render()
  }

  private positionPanel(): void {
    // Same slot as friends — CSS handles layout via .pets-panel-wrap
  }

  private wallet(): string | null {
    return this.options.getSession().getAddress()?.toLowerCase() ?? null
  }

  private setStatus(msg: string): void {
    this.statusEl.hidden = !msg
    this.statusEl.textContent = msg
  }

  private async handleUpload(file: File): Promise<void> {
    const address = this.wallet()
    if (!address) {
      this.setStatus('Sign in to save pets to your inventory.')
      return
    }
    if (this.busy) return
    this.busy = true
    this.setStatus(`Uploading ${file.name}…`)
    try {
      const entry = await addPetFile(file, this.uploadCategory)
      upsertOwnedPet(address, entry)
      this.setStatus('')
      await this.render()
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      this.busy = false
    }
  }

  private async render(): Promise<void> {
    const address = this.wallet()
    // Merge library + inventory so library-only rows still show after reinstall if IDB remains.
    const library = await listPetLibrary()
    const inv = getPetInventory(address)
    const byHash = new Map<string, PetLibraryEntry>()
    for (const e of library) byHash.set(e.contentHash, e)
    for (const e of inv.owned) {
      const prev = byHash.get(e.contentHash)
      byHash.set(e.contentHash, prev ? { ...prev, ...e } : e)
    }
    // Ensure inventory has library entries user owns in this wallet list.
    if (address) {
      for (const e of inv.owned) {
        if (!byHash.has(e.contentHash)) byHash.set(e.contentHash, e)
      }
    }

    const rows = [...byHash.values()].sort((a, b) =>
      (a.nickname || a.fileName).localeCompare(b.nickname || b.fileName, undefined, {
        sensitivity: 'base'
      })
    )
    const active = getActivePetEntry(address)

    if (!rows.length) {
      this.bodyEl.innerHTML = `<div class="pets-panel__empty">No pets yet. Upload a .glb and pick Walking or Flying.</div>`
      return
    }

    this.bodyEl.innerHTML = rows
      .map((e) => {
        const isActive = active?.contentHash === e.contentHash
        const label = escapeHtml(e.nickname || e.fileName)
        const yaw = e.meshYawOffsetDeg ?? 0
        const meta = `${e.category} · yaw ${yaw}° · ${formatPetByteSize(e.byteSize)} · ${e.contentHash.slice(0, 8)}…`
        return `
          <article class="pets-panel__row${isActive ? ' is-active' : ''}" data-hash="${e.contentHash}">
            <div class="pets-panel__row-main">
              <div class="pets-panel__row-name">${label}</div>
              <div class="pets-panel__row-meta">${escapeHtml(meta)}</div>
            </div>
            <div class="pets-panel__row-actions">
              <select class="pets-panel__select" data-cat="${e.contentHash}" aria-label="Category">
                <option value="walking"${e.category === 'walking' ? ' selected' : ''}>Walking</option>
                <option value="flying"${e.category === 'flying' ? ' selected' : ''}>Flying</option>
              </select>
              <select class="pets-panel__select" data-yaw="${e.contentHash}" aria-label="Mesh facing">
                <option value="0"${yaw === 0 ? ' selected' : ''}>Face 0°</option>
                <option value="90"${yaw === 90 ? ' selected' : ''}>Face +90°</option>
                <option value="180"${yaw === 180 || yaw === -180 ? ' selected' : ''}>Face 180°</option>
                <option value="-90"${yaw === -90 || yaw === 270 ? ' selected' : ''}>Face −90°</option>
              </select>
              <button type="button" class="pets-panel__btn${isActive ? ' is-on' : ''}" data-toggle="${e.contentHash}">
                ${isActive ? 'Disable' : 'Enable'}
              </button>
              <button type="button" class="pets-panel__btn pets-panel__btn--ghost" data-nick="${e.contentHash}" title="Rename">✎</button>
              <button type="button" class="pets-panel__btn pets-panel__btn--danger" data-del="${e.contentHash}" title="Remove">✕</button>
            </div>
          </article>
        `
      })
      .join('')
  }

  private async onBodyChange(ev: Event): Promise<void> {
    const t = ev.target as HTMLElement
    if (!(t instanceof HTMLSelectElement)) return
    const address = this.wallet()
    if (!address) {
      this.setStatus('Sign in to manage pets.')
      return
    }

    if (t.dataset.cat) {
      const hash = t.dataset.cat
      const category = t.value === 'flying' ? 'flying' : 'walking'
      setOwnedPetCategory(address, hash, category)
      await updatePetLibraryCategory(hash, category)
      const active = getActivePetEntry(address)
      if (active?.contentHash === hash) {
        await this.options.onActivePetChange?.()
      }
      await this.render()
      return
    }

    if (t.dataset.yaw) {
      const hash = t.dataset.yaw
      const deg = Number(t.value) || 0
      setOwnedPetMeshYawOffset(address, hash, deg)
      await updatePetLibraryMeshYaw(hash, deg)
      const active = getActivePetEntry(address)
      if (active?.contentHash === hash) {
        // Live mesh flip without full respawn when World is ready.
        await this.options.onActivePetChange?.()
      }
      await this.render()
    }
  }

  private async onBodyClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement
    const address = this.wallet()
    if (!address) {
      this.setStatus('Sign in to manage pets.')
      return
    }

    const toggle = t.closest<HTMLElement>('[data-toggle]')
    if (toggle?.dataset.toggle) {
      ev.preventDefault()
      const hash = toggle.dataset.toggle
      const active = getActivePetEntry(address)
      if (active?.contentHash === hash) {
        setActivePetHash(address, null)
      } else {
        // Ensure inventory owns this entry
        const lib = await listPetLibrary()
        const entry = lib.find((e) => e.contentHash === hash) ?? getPetInventory(address).owned.find((e) => e.contentHash === hash)
        if (entry) upsertOwnedPet(address, entry)
        setActivePetHash(address, hash)
      }
      await this.render()
      await this.options.onActivePetChange?.()
      return
    }

    const nick = t.closest<HTMLElement>('[data-nick]')
    if (nick?.dataset.nick) {
      const hash = nick.dataset.nick
      const inv = getPetInventory(address)
      const row = inv.owned.find((e) => e.contentHash === hash)
      const next = window.prompt('Pet nickname', row?.nickname || row?.fileName || '')
      if (next == null) return
      setOwnedPetNickname(address, hash, next.trim() || null)
      await this.render()
      return
    }

    const del = t.closest<HTMLElement>('[data-del]')
    if (del?.dataset.del) {
      const hash = del.dataset.del
      if (!window.confirm('Remove this pet from your inventory?')) return
      const wasActive = getActivePetEntry(address)?.contentHash === hash
      removeOwnedPet(address, hash)
      await removePetFromLibrary(hash)
      await this.render()
      if (wasActive) await this.options.onActivePetChange?.()
      return
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
