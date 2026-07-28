import type { SessionIdentity } from '../../../network/SessionIdentity'
import {
  addPetFile,
  ensurePetLibraryClipNames,
  formatPetByteSize,
  listPetLibrary,
  removePetFromLibrary,
  updatePetLibraryAnimClipMap,
  updatePetLibraryCategory,
  updatePetLibraryMeshYaw
} from '../../../pets/PetLibrary'
import {
  getActivePetEntry,
  getPetInventory,
  removeOwnedPet,
  setActivePetHash,
  setOwnedPetAnimClipMap,
  setOwnedPetCategory,
  setOwnedPetClipNames,
  setOwnedPetMeshYawOffset,
  setOwnedPetNickname,
  upsertOwnedPet
} from '../../../pets/petInventoryStorage'
import {
  isPetAnimState,
  normalizeAnimClipMap,
  petAnimStateLabel,
  PET_ANIM_STATES_BY_CATEGORY
} from '../../../pets/petCategories'
import {
  BUILTIN_PETS,
  builtinPetToLibraryEntry,
  ensureBuiltinPetBytes,
  isBuiltinPetHash
} from '../../../pets/builtinPets'
import type { PetAnimClipMap, PetAnimState, PetCategory, PetLibraryEntry } from '../../../pets/types'
import { PET_ANIM_STATES } from '../../../pets/types'

export type PetsPanelOptions = {
  getSession: () => SessionIdentity
  /** Called when user enables / disables / changes category of active pet. */
  onActivePetChange?: () => void | Promise<void>
  /** Preview a clip on the live/edit pet mesh. */
  onPlayClipPreview?: (contentHash: string, clipName: string) => void | Promise<boolean>
  onStopClipPreview?: () => void
  onClose?: () => void
  anchor?: () => HTMLElement | undefined
}

/**
 * Sidebar Pets inventory — list (enable/settings/trash) + full edit surface for clips.
 */
export class PetsPanel {
  readonly element: HTMLDivElement
  private visible = false
  private busy = false
  private uploadCategory: PetCategory = 'walking'
  /** When set, body shows edit surface for this pet instead of the list. */
  private editHash: string | null = null
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
        <div class="pets-panel__upload" data-upload-block>
          <div class="pets-panel__cat-row" role="group" aria-label="Upload category">
            <button type="button" class="pets-panel__cat is-active" data-upload-cat="walking">Walking</button>
            <button type="button" class="pets-panel__cat" data-upload-cat="flying">Flying</button>
          </div>
          <label class="pets-panel__upload-btn">
            Upload GLB
            <input type="file" accept=".glb,.gltf,model/gltf-binary,model/gltf+json" hidden data-file />
          </label>
        </div>
        <p class="pets-panel__hint" data-list-hint>One active pet. Settings maps animation tracks (incl. AFK after 5 min idle). Models sync to nearby peers.</p>
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
      if (ev.key === 'Escape' && this.visible) {
        if (this.editHash) {
          void this.closeEdit()
          return
        }
        this.hide()
      }
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
    this.editHash = null
    this.options.onStopClipPreview?.()
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

  private setListChromeVisible(show: boolean): void {
    const panel = this.element.querySelector('.pets-panel')
    panel?.classList.toggle('pets-panel--edit', !show)
    const upload = this.element.querySelector<HTMLElement>('[data-upload-block]')
    const hint = this.element.querySelector<HTMLElement>('[data-list-hint]')
    if (upload) upload.hidden = !show
    if (hint) hint.hidden = !show
    // Title: list = Pets, edit = blank (edit surface owns the title row)
    const title = this.element.querySelector<HTMLElement>('.pets-panel__title')
    if (title) title.textContent = show ? 'Pets' : 'Pet settings'
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
      if (entry.clipNames?.length) setOwnedPetClipNames(address, entry.contentHash, entry.clipNames)
      this.setStatus('')
      await this.render()
    } catch (err) {
      this.setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      this.busy = false
    }
  }

  /** Pull a bundled pet's GLB into the local cache. False = surfaced an error. */
  private async downloadBuiltin(hash: string): Promise<boolean> {
    if (this.busy) return false
    this.busy = true
    this.setStatus('Downloading pet…')
    try {
      const ready = await ensureBuiltinPetBytes(hash)
      this.setStatus(ready ? '' : 'Could not download this pet — check your connection.')
      return !!ready
    } finally {
      this.busy = false
    }
  }

  private async collectRows(): Promise<PetLibraryEntry[]> {
    const address = this.wallet()
    const library = await listPetLibrary()
    const inv = getPetInventory(address)
    const byHash = new Map<string, PetLibraryEntry>()
    // Built-ins list before download; library / inventory merge field-wise so a
    // thin DPET row (remote-pet.glb, no yaw/map) cannot wipe shipped Face 180°.
    for (const p of BUILTIN_PETS) byHash.set(p.contentHash, builtinPetToLibraryEntry(p))
    for (const e of library) {
      const prev = byHash.get(e.contentHash)
      byHash.set(e.contentHash, prev ? mergePetRow(prev, e) : e)
    }
    for (const e of inv.owned) {
      const prev = byHash.get(e.contentHash)
      byHash.set(e.contentHash, prev ? mergePetRow(prev, e) : e)
    }
    return [...byHash.values()].sort((a, b) =>
      (a.nickname || a.fileName).localeCompare(b.nickname || b.fileName, undefined, {
        sensitivity: 'base'
      })
    )
  }

  private async render(): Promise<void> {
    if (this.editHash) {
      await this.renderEdit(this.editHash)
      return
    }
    this.setListChromeVisible(true)
    const address = this.wallet()
    const rows = await this.collectRows()
    const active = getActivePetEntry(address)

    if (!rows.length) {
      this.bodyEl.innerHTML = `<div class="pets-panel__empty">No pets yet. Upload a .glb and pick Walking or Flying.</div>`
      return
    }

    this.bodyEl.innerHTML = rows
      .map((e) => {
        const isActive = active?.contentHash === e.contentHash
        const label = escapeHtml(e.nickname || e.fileName)
        const typeLabel = e.category === 'flying' ? 'Flying' : 'Walking'
        const meta = `${typeLabel} · ${formatPetByteSize(e.byteSize)}`
        return `
          <article class="pets-panel__row${isActive ? ' is-active' : ''}" data-hash="${e.contentHash}">
            <div class="pets-panel__row-top">
              <div class="pets-panel__row-main">
                <div class="pets-panel__row-name">${label}</div>
                <div class="pets-panel__row-meta">${escapeHtml(meta)}</div>
              </div>
              <div class="pets-panel__row-actions">
                <button
                  type="button"
                  class="pets-panel__toggle${isActive ? ' is-on' : ''}"
                  data-toggle="${e.contentHash}"
                  role="switch"
                  aria-checked="${isActive ? 'true' : 'false'}"
                  title="${isActive ? 'Disable pet' : 'Enable pet'}"
                  aria-label="${isActive ? 'Disable' : 'Enable'} ${label}"
                >
                  <span class="pets-panel__toggle-knob" aria-hidden="true"></span>
                </button>
                <button type="button" class="pets-panel__icon-btn" data-settings="${e.contentHash}" title="Settings" aria-label="Pet settings">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z" stroke="currentColor" stroke-width="1.6"/>
                    <path d="M19.4 13a7.7 7.7 0 0 0 .05-2l2-1.15-2-3.45-2.25.7a7.6 7.6 0 0 0-1.7-1L15 3.5h-6l-.5 2.6a7.6 7.6 0 0 0-1.7 1L4.55 6.4l-2 3.45 2 1.15a7.7 7.7 0 0 0 0 2l-2 1.15 2 3.45 2.25-.7a7.6 7.6 0 0 0 1.7 1l.5 2.6h6l.5-2.6a7.6 7.6 0 0 0 1.7-1l2.25.7 2-3.45-2-1.15Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
                  </svg>
                </button>
                <button type="button" class="pets-panel__icon-btn pets-panel__icon-btn--danger" data-del="${e.contentHash}" title="Remove" aria-label="Remove pet">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                    <path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2m-8 0 1 12a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1l1-12M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>
                  </svg>
                </button>
              </div>
            </div>
          </article>
        `
      })
      .join('')
  }

  private async renderEdit(hash: string): Promise<void> {
    this.setListChromeVisible(false)
    const address = this.wallet()
    const rows = await this.collectRows()
    let entry = rows.find((e) => e.contentHash === hash)
    if (!entry) {
      this.editHash = null
      await this.render()
      return
    }

    // Lazy-load clip names for older library rows.
    let clipNames = entry.clipNames ?? []
    if (!clipNames.length) {
      this.setStatus('Reading animation tracks…')
      clipNames = await ensurePetLibraryClipNames(hash)
      if (address && clipNames.length) setOwnedPetClipNames(address, hash, clipNames)
      entry = { ...entry, clipNames }
      this.setStatus('')
    }

    const yaw = entry.meshYawOffsetDeg ?? 0
    const map = normalizeAnimClipMap(entry.animClipMap) ?? {}
    const clipToState = invertClipMap(map, clipNames)
    const label = escapeHtml(entry.nickname || entry.fileName)
    // Behaviors this pet's category can actually reach, A→Z by display label.
    const behaviorStates = [...PET_ANIM_STATES_BY_CATEGORY[entry.category]].sort((a, b) =>
      petAnimStateLabel(a).localeCompare(petAnimStateLabel(b), undefined, { sensitivity: 'base' })
    )
    const otherCategoryLabel = entry.category === 'walking' ? 'flying' : 'walking'

    const trackRows =
      clipNames.length === 0
        ? `<div class="pets-panel__empty">No animation tracks in this GLB.</div>`
        : clipNames
            .map((clip) => {
              const bound = clipToState.get(clip) ?? ''
              // Offer only the bands this category can reach. A mapping left over
              // from the other category still shows (tagged) so it is visible and
              // fixable instead of silently reading as unmapped.
              const states = [...behaviorStates]
              if (bound && !states.includes(bound as PetAnimState)) {
                states.push(bound as PetAnimState)
              }
              const opts = [
                `<option value="">— unmapped —</option>`,
                ...states.map((s) => {
                  const stale = !behaviorStates.includes(s)
                  const label = stale
                    ? `${petAnimStateLabel(s)} (${otherCategoryLabel})`
                    : petAnimStateLabel(s)
                  return `<option value="${s}"${bound === s ? ' selected' : ''}>${escapeHtml(label)}</option>`
                })
              ].join('')
              return `
                <div class="pets-panel__track" data-clip="${escapeHtml(clip)}">
                  <span class="pets-panel__track-name" title="${escapeHtml(clip)}">${escapeHtml(clip)}</span>
                  <select class="pets-panel__select pets-panel__select--track" data-map-clip="${escapeHtml(clip)}" aria-label="Map ${escapeHtml(clip)}">
                    ${opts}
                  </select>
                  <button type="button" class="pets-panel__icon-btn" data-play-clip="${escapeHtml(clip)}" title="Play locally" aria-label="Play ${escapeHtml(clip)}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7L8 5Z"/></svg>
                  </button>
                </div>
              `
            })
            .join('')

    this.bodyEl.innerHTML = `
      <div class="pets-panel__edit">
        <button type="button" class="pets-panel__back" data-edit-back>← Back to list</button>
        <div class="pets-panel__edit-title-row">
          <div class="pets-panel__edit-title">${label}</div>
          <button type="button" class="pets-panel__btn pets-panel__btn--ghost pets-panel__btn--rename" data-edit-nick title="Rename">Rename</button>
        </div>
        <div class="pets-panel__edit-section">
          <label class="pets-panel__field">
            <span>Locomotion</span>
            <select class="pets-panel__select" data-edit-cat>
              <option value="walking"${entry.category === 'walking' ? ' selected' : ''}>Walking</option>
              <option value="flying"${entry.category === 'flying' ? ' selected' : ''}>Flying</option>
            </select>
          </label>
          <label class="pets-panel__field">
            <span>Mesh face</span>
            <select class="pets-panel__select" data-edit-yaw>
              <option value="0"${yaw === 0 ? ' selected' : ''}>Face 0°</option>
              <option value="90"${yaw === 90 ? ' selected' : ''}>Face +90°</option>
              <option value="180"${yaw === 180 || yaw === -180 ? ' selected' : ''}>Face 180°</option>
              <option value="-90"${yaw === -90 || yaw === 270 ? ' selected' : ''}>Face −90°</option>
            </select>
          </label>
        </div>
        <p class="pets-panel__edit-help">Map each track to a behavior. Multiple tracks on one behavior play randomly. <strong>AFK</strong> plays after 5 minutes of owner idle.</p>
        <div class="pets-panel__tracks-head">
          <span>Animation track</span>
          <span>Behavior</span>
          <span></span>
        </div>
        <div class="pets-panel__tracks">${trackRows}</div>
      </div>
    `
  }

  private async closeEdit(): Promise<void> {
    this.editHash = null
    this.options.onStopClipPreview?.()
    await this.render()
  }

  private async onBodyChange(ev: Event): Promise<void> {
    const t = ev.target as HTMLElement
    if (!(t instanceof HTMLSelectElement)) return
    const address = this.wallet()
    if (!address) {
      this.setStatus('Sign in to manage pets.')
      return
    }

    if (t.dataset.editCat !== undefined && this.editHash) {
      const category = t.value === 'flying' ? 'flying' : 'walking'
      setOwnedPetCategory(address, this.editHash, category)
      await updatePetLibraryCategory(this.editHash, category)
      // Behavior lists are category-specific — rebuild the mapper rows.
      await this.render()
      if (getActivePetEntry(address)?.contentHash === this.editHash) {
        await this.options.onActivePetChange?.()
      }
      return
    }

    if (t.dataset.editYaw !== undefined && this.editHash) {
      const deg = Number(t.value) || 0
      setOwnedPetMeshYawOffset(address, this.editHash, deg)
      await updatePetLibraryMeshYaw(this.editHash, deg)
      if (getActivePetEntry(address)?.contentHash === this.editHash) {
        await this.options.onActivePetChange?.()
      }
      return
    }

    if (t.dataset.mapClip && this.editHash) {
      const clip = t.dataset.mapClip
      const state = t.value
      await this.applyClipMapping(address, this.editHash, clip, state)
    }
  }

  private async applyClipMapping(
    address: string,
    hash: string,
    clip: string,
    stateRaw: string
  ): Promise<void> {
    const rows = await this.collectRows()
    const entry = rows.find((e) => e.contentHash === hash)
    if (!entry) return
    const map: PetAnimClipMap = { ...(normalizeAnimClipMap(entry.animClipMap) ?? {}) }
    // Remove clip from all pools first.
    for (const s of PET_ANIM_STATES) {
      const list = map[s]
      if (!list) continue
      map[s] = list.filter((n) => n !== clip)
      if (!map[s]!.length) delete map[s]
    }
    if (isPetAnimState(stateRaw)) {
      const list = map[stateRaw] ?? []
      if (!list.includes(clip)) list.push(clip)
      map[stateRaw] = list
    }
    const next = normalizeAnimClipMap(map) ?? null
    setOwnedPetAnimClipMap(address, hash, next)
    await updatePetLibraryAnimClipMap(hash, next)
    if (getActivePetEntry(address)?.contentHash === hash) {
      await this.options.onActivePetChange?.()
    }
  }

  private async onBodyClick(ev: MouseEvent): Promise<void> {
    const t = ev.target as HTMLElement
    const address = this.wallet()
    if (!address) {
      this.setStatus('Sign in to manage pets.')
      return
    }

    if (t.closest('[data-edit-back]')) {
      ev.preventDefault()
      await this.closeEdit()
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
        // Built-ins are listed before they are downloaded — pull the GLB now, or
        // enableLocal would throw on missing bytes.
        if (isBuiltinPetHash(hash) && !(await this.downloadBuiltin(hash))) return
        const rows = await this.collectRows()
        const entry = rows.find((e) => e.contentHash === hash)
        if (entry) upsertOwnedPet(address, entry)
        setActivePetHash(address, hash)
      }
      await this.render()
      await this.options.onActivePetChange?.()
      return
    }

    const settings = t.closest<HTMLElement>('[data-settings]')
    if (settings?.dataset.settings) {
      ev.preventDefault()
      this.editHash = settings.dataset.settings
      await this.render()
      return
    }

    const play = t.closest<HTMLElement>('[data-play-clip]')
    if (play?.dataset.playClip && this.editHash) {
      ev.preventDefault()
      const clip = play.dataset.playClip
      // Preview needs real bytes even when the pet is not equipped.
      if (isBuiltinPetHash(this.editHash) && !(await this.downloadBuiltin(this.editHash))) return
      const ok = await this.options.onPlayClipPreview?.(this.editHash, clip)
      if (ok === false) this.setStatus('Could not play clip — enable the pet or wait for load.')
      else this.setStatus(`Playing “${clip}”…`)
      return
    }

    if (t.closest('[data-edit-nick]') && this.editHash) {
      const hash = this.editHash
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
      // A built-in ships with the client — trash frees the download, keeps the row.
      const prompt = isBuiltinPetHash(hash)
        ? 'Remove the downloaded copy? This pet stays in the list and can be re-enabled.'
        : 'Remove this pet from your inventory?'
      if (!window.confirm(prompt)) return
      const wasActive = getActivePetEntry(address)?.contentHash === hash
      removeOwnedPet(address, hash)
      await removePetFromLibrary(hash)
      if (this.editHash === hash) this.editHash = null
      await this.render()
      if (wasActive) await this.options.onActivePetChange?.()
    }
  }
}

/** clip → first anim state that lists it (for select UI). */
function invertClipMap(
  map: PetAnimClipMap,
  clipNames: string[]
): Map<string, PetAnimState> {
  const out = new Map<string, PetAnimState>()
  for (const state of PET_ANIM_STATES) {
    for (const clip of map[state] ?? []) {
      if (clipNames.includes(clip) && !out.has(clip)) out.set(clip, state)
    }
  }
  return out
}

/**
 * Overlay library/inventory on a base row without letting thin DPET rows wipe
 * shipped builtin face offset / clip map / real fileName.
 */
function mergePetRow(base: PetLibraryEntry, overlay: PetLibraryEntry): PetLibraryEntry {
  const overlayMapKeys = overlay.animClipMap ? Object.keys(overlay.animClipMap) : []
  const fileName =
    overlay.fileName && overlay.fileName !== 'remote-pet.glb'
      ? overlay.fileName
      : base.fileName || overlay.fileName
  return {
    ...base,
    ...overlay,
    fileName,
    nickname: overlay.nickname?.trim() ? overlay.nickname : base.nickname,
    meshYawOffsetDeg:
      typeof overlay.meshYawOffsetDeg === 'number'
        ? overlay.meshYawOffsetDeg
        : base.meshYawOffsetDeg,
    clipNames: overlay.clipNames?.length ? overlay.clipNames : base.clipNames,
    animClipMap: overlayMapKeys.length ? overlay.animClipMap : base.animClipMap
  }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
