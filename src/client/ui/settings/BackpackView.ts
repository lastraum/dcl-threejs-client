import * as THREE from 'three'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { AvatarAnimations } from '../../../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../../../avatar/AvatarComposer'
import { disposeWearableInstance } from '../../../avatar/loadWearable'
import type { WearableCategory } from '../../../avatar/types'
import { VrmAvatar } from '../../../avatar/vrm/VrmAvatar'
import { disposeVrmRoot } from '../../../avatar/vrm/VrmLoader'
import { OdkAvatar } from '../../../avatar/odk/OdkAvatar'
import { disposeOdkRoot } from '../../../avatar/odk/OdkLoader'
import { alignPreviewAvatarToGround } from '../../../avatar/avatarPreviewAlign'
import { renderCustomAvatarThumbnail } from '../../../avatar/customAvatarThumbnail'
import {
  addMmlFile,
  addMmlFromUrl,
  addVrmFile,
  addVrmFromUrl,
  findVrmLibraryByOsaId,
  formatVrmByteSize,
  listVrmLibrary,
  loadVrmLibraryBytes,
  removeVrmFromLibrary,
  updateVrmThumbnail,
  type VrmLibraryEntry
} from '../../../avatar/vrm/VrmLibrary'
import {
  fetchOsaGalleryCatalog,
  filterOsaGallery,
  OSA_GALLERY_URL,
  osaAvatarFileName,
  type OsaGalleryEntry
} from '../../../avatar/vrm/osaGallery'
import { fetchUrlBytes } from '../../../avatar/odk/parseMml'
import { getActiveProfileAddress } from '../../../avatar/LocalAvatar'
import {
  getEquippedCustomAvatar,
  setEquippedCustomAvatar
} from '../../../avatar/vrm/vrmEquipStorage'

type CategoryDef = { id: WearableCategory | 'all'; label: string; icon: string }
type BackpackSubTab = 'wearables' | 'emotes' | 'vrm' | 'osa'

const OSA_GRID_COLUMNS = 3
const OSA_GRID_ROWS = 3
const OSA_ITEMS_PER_PAGE = OSA_GRID_COLUMNS * OSA_GRID_ROWS

type BackpackViewOptions = {
  onVrmEquipChange?: () => void | Promise<void>
}

const CATEGORIES: CategoryDef[] = [
  { id: 'all', label: 'All', icon: '∞' },
  { id: 'body_shape', label: 'Body', icon: '👤' },
  { id: 'hair', label: 'Hair', icon: '💇' },
  { id: 'upper_body', label: 'Upper Body', icon: '👕' },
  { id: 'lower_body', label: 'Lower Body', icon: '👖' },
  { id: 'feet', label: 'Feet', icon: '👟' },
  { id: 'helmet', label: 'Helmet', icon: '⛑️' },
  { id: 'hat', label: 'Hat', icon: '🎩' },
  { id: 'mask', label: 'Mask', icon: '🎭' },
  { id: 'eyewear', label: 'Eyewear', icon: '👓' },
  { id: 'earring', label: 'Earring', icon: '💎' },
  { id: 'tiara', label: 'Tiara', icon: '👑' },
  { id: 'top_head', label: 'Top Head', icon: '🎀' },
  { id: 'facial_hair', label: 'Facial Hair', icon: '🧔' },
  { id: 'eyebrows', label: 'Eyebrows', icon: '🤨' },
  { id: 'mouth', label: 'Mouth', icon: '👄' },
  { id: 'hands_wear', label: 'Handwear', icon: '🧤' }
]

const RARITY_COLORS: Record<string, string> = {
  legendary: '#ff8723',
  epic: '#a335ee',
  rare: '#00b4d8',
  uncommon: '#57e389',
  common: '#888'
}

const ITEMS_PER_PAGE = 16

export class BackpackView {
  readonly root: HTMLElement
  private session: SessionIdentity
  private readonly onVrmEquipChange?: () => void | Promise<void>
  private activeSubTab: BackpackSubTab = 'wearables'
  private selectedCategory: WearableCategory | 'all' = 'all'
  private currentPage = 1
  private selectedItem: string | null = null
  private wearableUrns: string[] = []
  private vrmLibrary: VrmLibraryEntry[] = []
  private selectedVrmHash: string | null = null
  private vrmUploadBusy = false

  private previewCanvas: HTMLCanvasElement | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private pivot: THREE.Group | null = null
  private avatar: THREE.Object3D | null = null
  private vrmPreview: VrmAvatar | null = null
  private odkPreview: OdkAvatar | null = null
  private animations: AvatarAnimations | null = null
  private raf = 0
  private lastFrame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  private subjectSize = new THREE.Vector3(1.8, 1.8, 0.8)
  private previewMode: 'dcl' | 'vrm' | 'odk' = 'dcl'
  private vrmFileInput: HTMLInputElement | null = null
  private thumbGenGen = 0
  private thumbGenInProgress = false
  private osaCatalog: OsaGalleryEntry[] = []
  private osaCatalogLoading = false
  private osaCatalogError: string | null = null
  private osaSearchQuery = ''
  private selectedOsaId: string | null = null
  private osaPage = 1
  private osaPreviewRequest = 0
  private osaImportBusy = false

  constructor(session: SessionIdentity, options: BackpackViewOptions = {}) {
    this.session = session
    this.onVrmEquipChange = options.onVrmEquipChange
    this.root = document.createElement('div')
    this.root.className = 'backpack-view'

    this.root.innerHTML = `
      <div class="backpack-view__sub-header">
        <h2 class="backpack-view__title">Backpack</h2>
        <div class="backpack-view__sub-tabs">
          <button class="backpack-view__sub-tab is-active" data-subtab="wearables">
            <span>👕</span> Wearables
          </button>
          <button class="backpack-view__sub-tab" data-subtab="emotes">
            <span>💃</span> Emotes
          </button>
          <button class="backpack-view__sub-tab" data-subtab="vrm">
            <span>🧬</span> Custom Avatars
          </button>
          <button class="backpack-view__sub-tab" data-subtab="osa">
            <span>🌐</span> Open Source
          </button>
        </div>
        <div class="backpack-view__toolbar backpack-view__toolbar--wearables">
          <button class="backpack-view__filter-btn">⚙ FILTER &amp; SORT</button>
          <input class="backpack-view__search" type="text" placeholder="Search item" />
        </div>
        <input type="file" accept=".vrm,.mml,model/vrm" class="backpack-view__vrm-file-input" hidden />
      </div>
      <div class="backpack-view__columns">
        <div class="backpack-view__left">
          <div class="backpack-view__avatar-stage"></div>
        </div>
        <div class="backpack-view__middle">
          <div class="backpack-view__middle-tabs backpack-view__middle-tabs--wearables">
            <button class="backpack-view__mid-tab is-active" data-midtab="categories">☰ CATEGORIES</button>
            <button class="backpack-view__mid-tab" data-midtab="outfits">♡ SAVED OUTFITS</button>
            <a class="backpack-view__marketplace-link" href="https://market.decentraland.org" target="_blank" rel="noopener">🛒 MARKETPLACE</a>
          </div>
          <div class="backpack-view__middle-tabs backpack-view__middle-tabs--vrm" hidden>
            <span class="backpack-view__vrm-library-label">Your avatar library (stored on this device)</span>
            <div class="backpack-view__vrm-url-row">
              <input class="backpack-view__vrm-url-input" type="url" placeholder="Paste .mml URL" />
              <button type="button" class="backpack-view__vrm-url-btn">Import MML</button>
            </div>
          </div>
          <div class="backpack-view__middle-tabs backpack-view__middle-tabs--osa" hidden>
            <input class="backpack-view__osa-search" type="search" placeholder="Search open source avatars…" />
            <span class="backpack-view__osa-count" aria-live="polite"></span>
            <a class="backpack-view__osa-link" href="${OSA_GALLERY_URL}" target="_blank" rel="noopener">opensourceavatars.com</a>
          </div>
          <div class="backpack-view__middle-body">
            <aside class="backpack-view__categories"></aside>
            <div class="backpack-view__grid-area">
              <div class="backpack-view__vrm-drop-hint" hidden>
                <span class="backpack-view__vrm-drop-hint-icon" aria-hidden="true">🧬</span>
                <p class="backpack-view__vrm-drop-hint-title">Drop .vrm or .mml here</p>
                <p class="backpack-view__vrm-drop-hint-sub">or click to browse · MML fetches the GLB once · stored on this device</p>
              </div>
              <div class="backpack-view__grid"></div>
              <div class="backpack-view__pagination"></div>
            </div>
          </div>
        </div>
        <div class="backpack-view__right">
          <div class="backpack-view__detail">
            <p class="backpack-view__detail-empty">No item selected</p>
          </div>
        </div>
      </div>
    `

    this.vrmFileInput = this.root.querySelector('.backpack-view__vrm-file-input')
    this.buildCategories()
    this.loadWearables()
    this.initAvatarPreview()
    this.wireSubTabs()
    this.wireVrmDropZone()
    this.wireMmlUrlImport()
    this.wireOsaSearch()
    void this.refreshVrmLibrary()
  }

  private wireOsaSearch(): void {
    const input = this.root.querySelector('.backpack-view__osa-search') as HTMLInputElement | null
    input?.addEventListener('input', () => {
      this.osaSearchQuery = input.value
      this.osaPage = 1
      if (this.activeSubTab === 'osa') this.renderOsaGrid()
    })
  }

  private wireMmlUrlImport(): void {
    const input = this.root.querySelector('.backpack-view__vrm-url-input') as HTMLInputElement | null
    const btn = this.root.querySelector('.backpack-view__vrm-url-btn') as HTMLButtonElement | null
    btn?.addEventListener('click', () => {
      const url = input?.value.trim()
      if (!url || this.vrmUploadBusy) return
      void this.handleMmlUrlImport(url)
    })
    input?.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const url = input.value.trim()
        if (url && !this.vrmUploadBusy) void this.handleMmlUrlImport(url)
      }
    })
  }

  updateSession(session: SessionIdentity): void {
    this.session = session
    this.loadWearables()
    this.updateCategoryEquipped()
    void this.refreshVrmLibrary()
    if (this.activeSubTab === 'wearables') {
      void this.loadAvatarModel()
    }
  }

  private wireSubTabs(): void {
    const subTabs = this.root.querySelectorAll('.backpack-view__sub-tab')
    subTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        const tab = (btn as HTMLElement).dataset.subtab as BackpackSubTab | undefined
        if (!tab || tab === this.activeSubTab) return
        this.activeSubTab = tab
        subTabs.forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')
        this.applySubTabLayout()
      })
    })

    const midTabs = this.root.querySelectorAll('.backpack-view__mid-tab')
    midTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        midTabs.forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')
      })
    })

    this.vrmFileInput?.addEventListener('change', () => {
      const file = this.vrmFileInput?.files?.[0]
      if (this.vrmFileInput) this.vrmFileInput.value = ''
      if (file) void this.handleCustomAvatarUpload(file)
    })
  }

  private wireVrmDropZone(): void {
    const gridArea = this.root.querySelector('.backpack-view__grid-area') as HTMLElement
    const dropHint = this.root.querySelector('.backpack-view__vrm-drop-hint') as HTMLElement

    dropHint?.addEventListener('click', (e) => {
      e.stopPropagation()
      if (this.activeSubTab === 'vrm' && !this.vrmUploadBusy) this.vrmFileInput?.click()
    })

    gridArea.addEventListener('dragenter', (e) => {
      if (this.activeSubTab !== 'vrm' || this.vrmUploadBusy) return
      e.preventDefault()
      gridArea.classList.add('is-dragover')
    })

    gridArea.addEventListener('dragover', (e) => {
      if (this.activeSubTab !== 'vrm' || this.vrmUploadBusy) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
      gridArea.classList.add('is-dragover')
    })

    gridArea.addEventListener('dragleave', (e) => {
      if (!gridArea.contains(e.relatedTarget as Node)) {
        gridArea.classList.remove('is-dragover')
      }
    })

    gridArea.addEventListener('drop', (e) => {
      gridArea.classList.remove('is-dragover')
      if (this.activeSubTab !== 'vrm' || this.vrmUploadBusy) return
      e.preventDefault()
      const file = this.pickCustomAvatarFile(e.dataTransfer)
      if (file) void this.handleCustomAvatarUpload(file)
    })
  }

  private pickCustomAvatarFile(dataTransfer: DataTransfer | null): File | null {
    if (!dataTransfer?.files?.length) return null
    for (const file of dataTransfer.files) {
      const lower = file.name.toLowerCase()
      if (lower.endsWith('.vrm') || lower.endsWith('.mml')) return file
    }
    return null
  }

  private applySubTabLayout(): void {
    const wearablesToolbar = this.root.querySelector('.backpack-view__toolbar--wearables') as HTMLElement
    const wearablesMidTabs = this.root.querySelector('.backpack-view__middle-tabs--wearables') as HTMLElement
    const vrmMidTabs = this.root.querySelector('.backpack-view__middle-tabs--vrm') as HTMLElement
    const osaMidTabs = this.root.querySelector('.backpack-view__middle-tabs--osa') as HTMLElement
    const dropHint = this.root.querySelector('.backpack-view__vrm-drop-hint') as HTMLElement
    const categories = this.root.querySelector('.backpack-view__categories') as HTMLElement
    const gridArea = this.root.querySelector('.backpack-view__grid-area') as HTMLElement
    const isVrm = this.activeSubTab === 'vrm'
    const isOsa = this.activeSubTab === 'osa'
    const isAvatarLibraryTab = isVrm || isOsa

    this.root.classList.toggle('backpack-view--vrm', isVrm)
    this.root.classList.toggle('backpack-view--osa', isOsa)
    wearablesToolbar.hidden = isAvatarLibraryTab
    wearablesMidTabs.hidden = isAvatarLibraryTab
    vrmMidTabs.hidden = !isVrm
    osaMidTabs.hidden = !isOsa
    dropHint.hidden = !isVrm
    categories.hidden = isAvatarLibraryTab
    gridArea?.classList.remove('is-dragover')

    if (isVrm) {
      this.renderVrmGrid()
      void this.loadCustomAvatarPreview(this.selectedVrmHash)
    } else if (isOsa) {
      void this.ensureOsaCatalog()
    } else if (this.activeSubTab === 'wearables') {
      this.renderGrid()
      void this.loadAvatarModel()
    } else {
      this.renderGrid()
      const detailEl = this.root.querySelector('.backpack-view__detail')!
      detailEl.innerHTML = `<p class="backpack-view__detail-empty">Emotes — use the emote wheel in-world</p>`
    }
  }

  private buildCategories(): void {
    const container = this.root.querySelector('.backpack-view__categories')!
    for (const cat of CATEGORIES) {
      const btn = document.createElement('button')
      btn.className =
        'backpack-view__cat-btn' +
        (cat.id === 'all' ? ' backpack-view__cat-btn--all is-active' : cat.id === this.selectedCategory ? ' is-active' : '')
      btn.dataset.category = cat.id
      btn.innerHTML = `
        <div class="backpack-view__cat-thumb">${this.renderCategoryThumb(cat)}</div>
        <span class="backpack-view__cat-label">${cat.label}</span>
      `
      btn.addEventListener('click', () => {
        this.selectedCategory = cat.id
        this.currentPage = 1
        container.querySelectorAll('.backpack-view__cat-btn').forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')
        this.renderGrid()
      })
      container.appendChild(btn)
    }
  }

  private renderCategoryThumb(cat: CategoryDef): string {
    if (cat.id === 'all') {
      return `<span class="backpack-view__cat-all-icon">${cat.icon}</span>`
    }
    const equippedUrn = this.getEquippedUrn(cat.id)
    if (equippedUrn) {
      return `<img class="backpack-view__cat-equipped" src="${this.getItemThumbnail(equippedUrn)}" alt="" loading="lazy" />`
    }
    return `<span class="backpack-view__cat-slot-icon">${cat.icon}</span>`
  }

  private updateCategoryEquipped(): void {
    const container = this.root.querySelector('.backpack-view__categories')
    if (!container) return
    for (const cat of CATEGORIES) {
      if (cat.id === 'all') continue
      const btn = container.querySelector(`[data-category="${cat.id}"]`)
      if (!btn) continue
      const thumb = btn.querySelector('.backpack-view__cat-thumb')
      if (thumb) thumb.innerHTML = this.renderCategoryThumb(cat)
    }
  }

  private getEquippedUrn(category: WearableCategory): string | null {
    const profile = this.session.getProfile()
    if (!profile) return null
    const match = profile.wearables.find((urn) => urn.includes(`/${category}/`) || urn.includes(`:${category}:`))
    return match ?? null
  }

  private loadWearables(): void {
    const profile = this.session.getProfile()
    if (profile) {
      this.wearableUrns = profile.wearables.filter((u) => !u.includes('basemale') && !u.includes('basefemale'))
    } else {
      this.wearableUrns = []
    }
    this.renderGrid()
    this.updateCategoryEquipped()
  }

  private async refreshVrmLibrary(): Promise<void> {
    this.vrmLibrary = await listVrmLibrary()
    const equipped = getEquippedCustomAvatar(this.resolveEquipAddress())?.contentHash ?? null
    if (equipped && !this.selectedVrmHash) {
      this.selectedVrmHash = equipped
    }
    if (this.activeSubTab === 'vrm') {
      this.renderVrmGrid()
    } else if (this.activeSubTab === 'osa') {
      this.renderOsaGrid()
    }
  }

  private renderGrid(): void {
    const gridEl = this.root.querySelector('.backpack-view__grid')!
    const paginationEl = this.root.querySelector('.backpack-view__pagination')!
    gridEl.innerHTML = ''
    paginationEl.innerHTML = ''

    const items = this.selectedCategory === 'all'
      ? this.wearableUrns
      : this.wearableUrns.filter((u) => u.includes(this.selectedCategory))
    const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE))
    const page = Math.min(this.currentPage, totalPages)
    const start = (page - 1) * ITEMS_PER_PAGE
    const pageItems = items.slice(start, start + ITEMS_PER_PAGE)

    for (const urn of pageItems) {
      const card = document.createElement('div')
      const isSelected = urn === this.selectedItem
      card.className = 'backpack-view__item' + (isSelected ? ' is-selected' : '')
      const rarity = this.guessRarity(urn)
      card.style.borderColor = RARITY_COLORS[rarity] ?? RARITY_COLORS.common
      const thumbUrl = this.getItemThumbnail(urn)
      card.innerHTML = `<img class="backpack-view__item-img" src="${thumbUrl}" alt="" loading="lazy" />`
      card.addEventListener('click', () => { this.selectItem(urn); this.renderGrid() })
      gridEl.appendChild(card)
    }

    const emptySlots = ITEMS_PER_PAGE - pageItems.length
    for (let i = 0; i < emptySlots; i++) {
      const empty = document.createElement('div')
      empty.className = 'backpack-view__item backpack-view__item--empty'
      gridEl.appendChild(empty)
    }

    if (totalPages > 1) {
      const prev = document.createElement('button')
      prev.className = 'backpack-view__page-btn'
      prev.textContent = '‹'
      prev.disabled = page <= 1
      prev.addEventListener('click', () => { this.currentPage--; this.renderGrid() })
      paginationEl.appendChild(prev)

      for (let i = 1; i <= Math.min(totalPages, 5); i++) {
        const pageBtn = document.createElement('button')
        pageBtn.className = 'backpack-view__page-btn' + (i === page ? ' is-active' : '')
        pageBtn.textContent = String(i)
        pageBtn.addEventListener('click', () => { this.currentPage = i; this.renderGrid() })
        paginationEl.appendChild(pageBtn)
      }

      const next = document.createElement('button')
      next.className = 'backpack-view__page-btn'
      next.textContent = '›'
      next.disabled = page >= totalPages
      next.addEventListener('click', () => { this.currentPage++; this.renderGrid() })
      paginationEl.appendChild(next)
    }
  }

  private renderVrmGrid(skipThumbGen = false): void {
    const gridEl = this.root.querySelector('.backpack-view__grid')!
    const paginationEl = this.root.querySelector('.backpack-view__pagination')!
    gridEl.innerHTML = ''
    gridEl.classList.remove('backpack-view__grid--vrm-empty')
    paginationEl.innerHTML = ''

    if (!this.vrmLibrary.length) {
      gridEl.classList.add('backpack-view__grid--vrm-empty')
      this.renderVrmDetail(null)
      return
    }

    gridEl.classList.remove('backpack-view__grid--vrm-empty')

    for (const entry of this.vrmLibrary) {
      const card = document.createElement('button')
      card.type = 'button'
      const isSelected = entry.contentHash === this.selectedVrmHash
      const equipped = getEquippedCustomAvatar(this.resolveEquipAddress())
      const isEquipped =
        equipped?.contentHash === entry.contentHash && equipped.format === entry.format
      const formatLabel = entry.format === 'odk' ? 'ODK' : 'VRM'
      card.className =
        'backpack-view__vrm-card' +
        (isSelected ? ' is-selected' : '') +
        (isEquipped ? ' is-equipped' : '')
      const thumbSrc = entry.thumbnailDataUrl ?? entry.externalThumbnailUrl
      const thumbHtml = thumbSrc
        ? `<img class="backpack-view__vrm-card-img" src="${this.escapeHtml(thumbSrc)}" alt="" loading="lazy" />`
        : `<span class="backpack-view__vrm-card-fallback" aria-hidden="true">${entry.format === 'odk' ? '🌐' : '🧬'}</span>`
      card.innerHTML = `
        <div class="backpack-view__vrm-card-thumb">${thumbHtml}</div>
        <span class="backpack-view__vrm-card-format">${formatLabel}</span>
        <span class="backpack-view__vrm-card-name">${this.escapeHtml(entry.fileName)}</span>
        <span class="backpack-view__vrm-card-size">${formatVrmByteSize(entry.byteSize)}</span>
        ${isEquipped ? '<span class="backpack-view__vrm-equipped-badge">Equipped</span>' : ''}
      `
      card.addEventListener('click', () => {
        this.selectedVrmHash = entry.contentHash
        this.renderVrmGrid()
        void this.loadCustomAvatarPreview(entry.contentHash)
      })
      gridEl.appendChild(card)
    }

    if (!skipThumbGen) void this.ensureVrmThumbnails()
  }

  private async ensureOsaCatalog(): Promise<void> {
    if (this.osaCatalog.length) {
      this.renderOsaGrid()
      return
    }
    if (this.osaCatalogLoading) return
    this.osaCatalogLoading = true
    this.osaCatalogError = null
    this.renderOsaGrid()
    try {
      this.osaCatalog = await fetchOsaGalleryCatalog()
      if (this.disposed || this.activeSubTab !== 'osa') return
      this.renderOsaGrid()
      if (!this.selectedOsaId && this.osaCatalog[0]) {
        this.selectedOsaId = this.osaCatalog[0].id
        void this.loadOsaPreview(this.osaCatalog[0])
      }
    } catch (err) {
      this.osaCatalogError = err instanceof Error ? err.message : String(err)
      if (this.activeSubTab === 'osa') this.renderOsaGrid()
    } finally {
      this.osaCatalogLoading = false
    }
  }

  private getFilteredOsaCatalog(): OsaGalleryEntry[] {
    return filterOsaGallery(this.osaCatalog, this.osaSearchQuery)
  }

  private renderOsaGrid(): void {
    const gridEl = this.root.querySelector('.backpack-view__grid')!
    const paginationEl = this.root.querySelector('.backpack-view__pagination')!
    const countEl = this.root.querySelector('.backpack-view__osa-count') as HTMLElement | null
    gridEl.innerHTML = ''
    gridEl.classList.remove('backpack-view__grid--vrm-empty')
    paginationEl.innerHTML = ''

    if (this.osaCatalogLoading && !this.osaCatalog.length) {
      gridEl.innerHTML = `<p class="backpack-view__osa-status">Loading open source avatars…</p>`
      if (countEl) countEl.textContent = ''
      this.renderOsaDetail(null)
      return
    }

    if (this.osaCatalogError) {
      gridEl.innerHTML = `<p class="backpack-view__osa-status backpack-view__osa-status--error">${this.escapeHtml(this.osaCatalogError)}</p>`
      if (countEl) countEl.textContent = ''
      this.renderOsaDetail(null)
      return
    }

    const filtered = this.getFilteredOsaCatalog()
    if (countEl) {
      countEl.textContent =
        filtered.length === this.osaCatalog.length
          ? `${filtered.length} avatars`
          : `${filtered.length} of ${this.osaCatalog.length}`
    }

    if (!filtered.length) {
      gridEl.classList.add('backpack-view__grid--vrm-empty')
      gridEl.innerHTML = `<p class="backpack-view__osa-status">No avatars match your search</p>`
      this.renderOsaDetail(null)
      return
    }

    const totalPages = Math.max(1, Math.ceil(filtered.length / OSA_ITEMS_PER_PAGE))
    const page = Math.min(this.osaPage, totalPages)
    const start = (page - 1) * OSA_ITEMS_PER_PAGE
    const pageItems = filtered.slice(start, start + OSA_ITEMS_PER_PAGE)

    for (const entry of pageItems) {
      const card = document.createElement('button')
      card.type = 'button'
      const isSelected = entry.id === this.selectedOsaId
      const inLibrary = this.vrmLibrary.some((e) => e.osaSourceId === entry.id)
      card.className =
        'backpack-view__vrm-card backpack-view__osa-card' +
        (isSelected ? ' is-selected' : '') +
        (inLibrary ? ' is-in-library' : '')
      const thumb = entry.thumbnail_url
        ? `<img class="backpack-view__vrm-card-img" src="${this.escapeHtml(entry.thumbnail_url)}" alt="" loading="lazy" />`
        : `<span class="backpack-view__vrm-card-fallback" aria-hidden="true">🌐</span>`
      card.innerHTML = `
        <div class="backpack-view__vrm-card-thumb">${thumb}</div>
        <span class="backpack-view__vrm-card-format">OSA · ${this.escapeHtml(entry.license)}</span>
        <span class="backpack-view__vrm-card-name">${this.escapeHtml(entry.name)}</span>
        <span class="backpack-view__vrm-card-size">${this.escapeHtml(entry.projectName)}</span>
        ${inLibrary ? '<span class="backpack-view__osa-library-badge">In library</span>' : ''}
      `
      card.addEventListener('click', () => {
        this.selectedOsaId = entry.id
        this.renderOsaGrid()
        void this.loadOsaPreview(entry)
      })
      gridEl.appendChild(card)
    }

    if (totalPages > 1) {
      const prev = document.createElement('button')
      prev.className = 'backpack-view__page-btn'
      prev.textContent = '‹'
      prev.disabled = page <= 1
      prev.addEventListener('click', () => {
        this.osaPage = Math.max(1, page - 1)
        this.renderOsaGrid()
      })
      paginationEl.appendChild(prev)

      for (let i = 1; i <= Math.min(totalPages, 5); i++) {
        const pageBtn = document.createElement('button')
        pageBtn.className = 'backpack-view__page-btn' + (i === page ? ' is-active' : '')
        pageBtn.textContent = String(i)
        pageBtn.addEventListener('click', () => {
          this.osaPage = i
          this.renderOsaGrid()
        })
        paginationEl.appendChild(pageBtn)
      }

      const next = document.createElement('button')
      next.className = 'backpack-view__page-btn'
      next.textContent = '›'
      next.disabled = page >= totalPages
      next.addEventListener('click', () => {
        this.osaPage = Math.min(totalPages, page + 1)
        this.renderOsaGrid()
      })
      paginationEl.appendChild(next)
    }

    const selected =
      (this.selectedOsaId ? filtered.find((e) => e.id === this.selectedOsaId) : undefined) ??
      pageItems[0] ??
      null
    if (selected && selected.id !== this.selectedOsaId) {
      this.selectedOsaId = selected.id
      void this.loadOsaPreview(selected)
    }
    this.renderOsaDetail(selected)
  }

  private renderOsaDetail(entry: OsaGalleryEntry | null): void {
    const detailEl = this.root.querySelector('.backpack-view__detail')!
    if (!entry) {
      detailEl.innerHTML = `<p class="backpack-view__detail-empty">Select an open source avatar to preview</p>`
      return
    }

    void findVrmLibraryByOsaId(entry.id).then((libraryEntry) => {
      if (this.disposed || this.selectedOsaId !== entry.id) return
      const inLibrary = !!libraryEntry
      const address = this.resolveEquipAddress()
      const equipped = getEquippedCustomAvatar(address)
      const isEquipped =
        !!libraryEntry &&
        equipped?.contentHash === libraryEntry.contentHash &&
        equipped.format === 'vrm'

      detailEl.innerHTML = `
        <div class="backpack-view__detail-card backpack-view__detail-card--vrm">
          ${entry.thumbnail_url ? `<img class="backpack-view__osa-detail-thumb" src="${this.escapeHtml(entry.thumbnail_url)}" alt="" />` : '<div class="backpack-view__vrm-detail-icon">🌐</div>'}
          <h3 class="backpack-view__detail-name">${this.escapeHtml(entry.name)}</h3>
          <p class="backpack-view__vrm-detail-meta">${this.escapeHtml(entry.projectName)} · ${this.escapeHtml(entry.license)}</p>
          ${entry.description ? `<p class="backpack-view__osa-detail-desc">${this.escapeHtml(entry.description)}</p>` : ''}
          <p class="backpack-view__vrm-detail-meta"><a href="${OSA_GALLERY_URL}" target="_blank" rel="noopener">Open Source Avatars</a></p>
          <div class="backpack-view__vrm-actions">
            <button type="button" class="backpack-view__vrm-equip-btn" data-action="add-library" ${inLibrary || this.osaImportBusy ? 'disabled' : ''}>
              ${inLibrary ? 'In your library' : 'Add to library'}
            </button>
            <button type="button" class="backpack-view__vrm-equip-btn" data-action="add-equip" ${!inLibrary || this.osaImportBusy ? 'disabled' : ''} ${isEquipped ? 'disabled' : ''}>
              ${isEquipped ? 'Equipped' : inLibrary ? 'Equip' : 'Add & equip'}
            </button>
            ${inLibrary ? `<button type="button" class="backpack-view__vrm-unequip-btn" data-action="open-library">Open in Custom Avatars</button>` : ''}
          </div>
        </div>
      `

      detailEl.querySelector('[data-action="add-library"]')?.addEventListener('click', () => {
        if (!inLibrary) void this.addOsaToLibrary(entry, false)
      })
      detailEl.querySelector('[data-action="add-equip"]')?.addEventListener('click', () => {
        if (inLibrary && libraryEntry) void this.equipVrm(libraryEntry.contentHash)
        else void this.addOsaToLibrary(entry, true)
      })
      detailEl.querySelector('[data-action="open-library"]')?.addEventListener('click', () => {
        if (!libraryEntry) return
        this.selectedVrmHash = libraryEntry.contentHash
        this.activeSubTab = 'vrm'
        this.root.querySelectorAll('.backpack-view__sub-tab').forEach((btn) => {
          btn.classList.toggle('is-active', (btn as HTMLElement).dataset.subtab === 'vrm')
        })
        this.applySubTabLayout()
      })
    })
  }

  private async loadOsaPreview(entry: OsaGalleryEntry): Promise<void> {
    const req = ++this.osaPreviewRequest
    this.renderOsaDetail(entry)
    this.previewMode = 'vrm'
    this.clearAvatar()

    try {
      const bytes = await fetchUrlBytes(entry.model_file_url)
      if (req !== this.osaPreviewRequest || this.disposed || this.activeSubTab !== 'osa') return

      const vrm = await VrmAvatar.fromBytes(bytes)
      if (req !== this.osaPreviewRequest || this.disposed || this.activeSubTab !== 'osa') {
        vrm.dispose()
        return
      }

      this.vrmPreview = vrm
      this.avatar = vrm.root
      this.pivot!.add(vrm.root)
      this.subjectSize = alignPreviewAvatarToGround(vrm.root, 'vrm', vrm.vrm)
      this.frameCamera(this.subjectSize)
    } catch (err) {
      console.warn('[backpack] OSA preview failed', err)
      if (req === this.osaPreviewRequest && this.activeSubTab === 'osa') {
        this.previewMode = 'dcl'
        await this.loadAvatarModel()
      }
    }
  }

  private async addOsaToLibrary(entry: OsaGalleryEntry, equipAfter: boolean): Promise<void> {
    if (this.osaImportBusy) return
    this.osaImportBusy = true
    const gridArea = this.root.querySelector('.backpack-view__grid-area') as HTMLElement
    gridArea?.classList.add('is-uploading')
    this.renderOsaDetail(entry)

    try {
      const libraryEntry = await addVrmFromUrl(entry.model_file_url, osaAvatarFileName(entry), {
        osaSourceId: entry.id,
        sourceModelUrl: entry.model_file_url,
        externalThumbnailUrl: entry.thumbnail_url
      })
      await this.refreshVrmLibrary()
      this.selectedVrmHash = libraryEntry.contentHash
      this.renderOsaGrid()
      this.renderOsaDetail(entry)

      if (equipAfter) {
        await this.equipVrm(libraryEntry.contentHash)
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`Could not add avatar: ${msg}`)
    } finally {
      this.osaImportBusy = false
      gridArea?.classList.remove('is-uploading')
      this.renderOsaDetail(entry)
    }
  }

  private async ensureVrmThumbnails(): Promise<void> {
    if (this.thumbGenInProgress) return
    this.thumbGenInProgress = true
    const gen = ++this.thumbGenGen
    let changed = false
    try {
      for (const entry of this.vrmLibrary) {
        if (entry.thumbnailDataUrl || entry.externalThumbnailUrl) continue
        const bytes = await loadVrmLibraryBytes(entry.contentHash)
        if (!bytes || gen !== this.thumbGenGen || this.disposed) return
        try {
          const dataUrl = await renderCustomAvatarThumbnail(bytes, entry.format, entry.mmlAttachments)
          if (gen !== this.thumbGenGen || this.disposed) return
          await updateVrmThumbnail(entry.contentHash, dataUrl)
          entry.thumbnailDataUrl = dataUrl
          changed = true
        } catch (err) {
          console.warn('[backpack] avatar thumbnail failed', entry.fileName, err)
        }
      }
      if (changed && this.activeSubTab === 'vrm' && !this.disposed) this.renderVrmGrid(true)
    } finally {
      this.thumbGenInProgress = false
    }
  }

  private renderVrmDetail(entry: VrmLibraryEntry | null): void {
    const detailEl = this.root.querySelector('.backpack-view__detail')!
    if (!entry) {
      detailEl.innerHTML = `<p class="backpack-view__detail-empty">Select or upload a VRM / MML avatar</p>`
      return
    }

    const address = this.session.getAddress()
    const equipped = getEquippedCustomAvatar(address)
    const isEquipped =
      equipped?.contentHash === entry.contentHash && equipped.format === entry.format

    detailEl.innerHTML = `
      <div class="backpack-view__detail-card backpack-view__detail-card--vrm">
        <div class="backpack-view__vrm-detail-icon">${entry.format === 'odk' ? '🌐' : '🧬'}</div>
        <h3 class="backpack-view__detail-name">${this.escapeHtml(entry.fileName)}</h3>
        <p class="backpack-view__vrm-detail-meta">${entry.format.toUpperCase()} · ${formatVrmByteSize(entry.byteSize)} · ${new Date(entry.addedAt).toLocaleDateString()}</p>
        ${entry.mmlSourceUrl ? `<p class="backpack-view__vrm-detail-meta"><a href="${this.escapeHtml(entry.mmlSourceUrl)}" target="_blank" rel="noopener">MML source</a></p>` : ''}
        <p class="backpack-view__detail-urn">${entry.contentHash.slice(0, 16)}…</p>
        <div class="backpack-view__vrm-actions">
          <button type="button" class="backpack-view__vrm-equip-btn" data-action="equip" ${isEquipped ? 'disabled' : ''}>
            ${isEquipped ? 'Equipped' : 'Equip'}
          </button>
          <button type="button" class="backpack-view__vrm-unequip-btn" data-action="unequip" ${isEquipped ? '' : 'hidden'}>
            Unequip (DCL avatar)
          </button>
          <button type="button" class="backpack-view__vrm-delete-btn" data-action="delete">
            Delete from library
          </button>
        </div>
      </div>
    `

    detailEl.querySelector('[data-action="equip"]')?.addEventListener('click', () => {
      void this.equipVrm(entry.contentHash)
    })
    detailEl.querySelector('[data-action="unequip"]')?.addEventListener('click', () => {
      void this.unequipVrm()
    })
    detailEl.querySelector('[data-action="delete"]')?.addEventListener('click', () => {
      void this.deleteVrm(entry.contentHash)
    })
  }

  private async handleCustomAvatarUpload(file: File): Promise<void> {
    if (this.vrmUploadBusy) return
    this.vrmUploadBusy = true
    const gridArea = this.root.querySelector('.backpack-view__grid-area') as HTMLElement
    gridArea?.classList.add('is-uploading')

    try {
      const entry = file.name.toLowerCase().endsWith('.mml')
        ? await addMmlFile(file)
        : await addVrmFile(file)
      await this.refreshVrmLibrary()
      this.selectedVrmHash = entry.contentHash
      this.activeSubTab = 'vrm'
      this.root.querySelectorAll('.backpack-view__sub-tab').forEach((btn) => {
        btn.classList.toggle('is-active', (btn as HTMLElement).dataset.subtab === 'vrm')
      })
      this.applySubTabLayout()
      void this.loadCustomAvatarPreview(entry.contentHash)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`Avatar upload failed: ${msg}`)
    } finally {
      this.vrmUploadBusy = false
      gridArea?.classList.remove('is-uploading')
    }
  }

  private resolveEquipAddress(): string | undefined {
    return this.session.getAddress() ?? getActiveProfileAddress()
  }

  private async handleMmlUrlImport(url: string): Promise<void> {
    if (this.vrmUploadBusy) return
    this.vrmUploadBusy = true
    const gridArea = this.root.querySelector('.backpack-view__grid-area') as HTMLElement
    gridArea?.classList.add('is-uploading')
    try {
      const entry = await addMmlFromUrl(url)
      await this.refreshVrmLibrary()
      this.selectedVrmHash = entry.contentHash
      this.activeSubTab = 'vrm'
      this.root.querySelectorAll('.backpack-view__sub-tab').forEach((btn) => {
        btn.classList.toggle('is-active', (btn as HTMLElement).dataset.subtab === 'vrm')
      })
      this.applySubTabLayout()
      void this.loadCustomAvatarPreview(entry.contentHash)
      const input = this.root.querySelector('.backpack-view__vrm-url-input') as HTMLInputElement | null
      if (input) input.value = ''
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`MML import failed: ${msg}`)
    } finally {
      this.vrmUploadBusy = false
      gridArea?.classList.remove('is-uploading')
    }
  }

  private async equipVrm(contentHash: string): Promise<void> {
    const address = this.resolveEquipAddress()
    if (!address) {
      alert('Set a profile wallet (?profile=0x…) or connect a wallet to equip a custom VRM.')
      return
    }
    const entry = this.vrmLibrary.find((e) => e.contentHash === contentHash)
    setEquippedCustomAvatar(address, {
      format: entry?.format ?? 'vrm',
      contentHash
    })
    this.selectedVrmHash = contentHash
    this.renderVrmGrid()
    this.renderVrmDetail(this.vrmLibrary.find((e) => e.contentHash === contentHash) ?? null)
    await this.onVrmEquipChange?.()
    void this.loadCustomAvatarPreview(contentHash)
  }

  private async unequipVrm(): Promise<void> {
    const address = this.resolveEquipAddress()
    if (!address) return
    setEquippedCustomAvatar(address, null)
    this.renderVrmGrid()
    const entry = this.selectedVrmHash
      ? this.vrmLibrary.find((e) => e.contentHash === this.selectedVrmHash) ?? null
      : null
    this.renderVrmDetail(entry)
    await this.onVrmEquipChange?.()
    void this.loadAvatarModel()
  }

  private async deleteVrm(contentHash: string): Promise<void> {
    const address = this.resolveEquipAddress()
    if (address && getEquippedCustomAvatar(address)?.contentHash === contentHash) {
      await this.unequipVrm()
    }
    await removeVrmFromLibrary(contentHash)
    if (this.selectedVrmHash === contentHash) {
      this.selectedVrmHash = null
    }
    await this.refreshVrmLibrary()
    this.renderVrmGrid()
    if (this.selectedVrmHash) {
      void this.loadCustomAvatarPreview(this.selectedVrmHash)
    } else {
      void this.loadCustomAvatarPreview(null)
    }
  }

  private selectItem(urn: string): void {
    this.selectedItem = urn
    const detailEl = this.root.querySelector('.backpack-view__detail')!
    const shortUrn = urn.split(':').pop() ?? urn
    const rarity = this.guessRarity(urn)
    detailEl.innerHTML = `
      <div class="backpack-view__detail-card">
        <img class="backpack-view__detail-img" src="${this.getItemThumbnail(urn)}" alt="" />
        <h3 class="backpack-view__detail-name">${shortUrn}</h3>
        <span class="backpack-view__detail-rarity" style="color:${RARITY_COLORS[rarity] ?? '#888'}">${rarity}</span>
        <p class="backpack-view__detail-urn">${urn}</p>
      </div>
    `
  }

  private guessRarity(urn: string): string {
    if (urn.includes('legendary')) return 'legendary'
    if (urn.includes('epic')) return 'epic'
    if (urn.includes('rare')) return 'rare'
    if (urn.includes('uncommon')) return 'uncommon'
    return 'common'
  }

  private getItemThumbnail(urn: string): string {
    return `https://peer.decentraland.org/lambdas/collections/contents/${urn}/thumbnail`
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  // --- Avatar 3D Preview ---

  private initAvatarPreview(): void {
    const stage = this.root.querySelector('.backpack-view__avatar-stage')! as HTMLElement

    this.previewCanvas = document.createElement('canvas')
    this.previewCanvas.className = 'backpack-view__canvas'
    stage.appendChild(this.previewCanvas)

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.previewCanvas,
      alpha: true,
      antialias: true
    })
    this.renderer.outputColorSpace = THREE.SRGBColorSpace
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(28, 1, 0.1, 50)

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.72))
    const key = new THREE.DirectionalLight(0xffffff, 1.15)
    key.position.set(2.5, 4.5, 3.5)
    this.scene.add(key)
    const rim = new THREE.DirectionalLight(0xc9a0ff, 0.45)
    rim.position.set(-3, 2, -2)
    this.scene.add(rim)

    const platformGeo = new THREE.CircleGeometry(0.72, 64)
    const platformMat = new THREE.MeshStandardMaterial({
      color: 0xf0b429,
      emissive: 0x5a3d00,
      emissiveIntensity: 0.35,
      metalness: 0.55,
      roughness: 0.35
    })
    const platform = new THREE.Mesh(platformGeo, platformMat)
    platform.rotation.x = -Math.PI / 2
    platform.position.y = 0.01
    this.scene.add(platform)

    const ringGeo = new THREE.RingGeometry(0.72, 0.82, 64)
    const ringMat = new THREE.MeshBasicMaterial({
      color: 0x1a1030,
      transparent: true,
      opacity: 0.85,
      side: THREE.DoubleSide
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = -Math.PI / 2
    this.scene.add(ring)

    this.pivot = new THREE.Group()
    this.scene.add(this.pivot)

    this.frameCamera(new THREE.Vector3(1.8, 1.8, 0.8))

    this.resizeObserver = new ResizeObserver(() => this.resizePreview())
    this.resizeObserver.observe(stage)
    this.resizePreview()

    this.lastFrame = performance.now()
    this.raf = requestAnimationFrame((t) => this.tick(t))

    void this.loadAvatarModel()
  }

  private async loadAvatarModel(): Promise<void> {
    this.previewMode = 'dcl'
    const profile = this.session.getProfile()
    const address = this.session.getAddress()
    if (!profile || !address) return

    this.clearAvatar()

    const avatar = await composeAvatarFromProfile({ ...profile, address, fromWallet: true })
    if (this.disposed || this.previewMode !== 'dcl') {
      this.disposeGraph(avatar)
      return
    }

    this.avatar = avatar
    this.pivot!.add(avatar)
    this.subjectSize = alignPreviewAvatarToGround(avatar, 'dcl')

    this.animations = new AvatarAnimations()
    try {
      await this.animations.bind(avatar)
    } catch {
      this.animations.dispose()
      this.animations = null
    }

    this.frameCamera(this.subjectSize)
  }

  private async loadCustomAvatarPreview(contentHash: string | null): Promise<void> {
    const entry = contentHash ? this.vrmLibrary.find((e) => e.contentHash === contentHash) ?? null : null
    this.renderVrmDetail(entry)

    if (!contentHash) {
      this.previewMode = 'dcl'
      await this.loadAvatarModel()
      return
    }

    const bytes = await loadVrmLibraryBytes(contentHash)
    if (!bytes) {
      this.previewMode = 'dcl'
      await this.loadAvatarModel()
      return
    }

    const format = entry?.format ?? 'vrm'
    this.previewMode = format === 'odk' ? 'odk' : 'vrm'
    this.clearAvatar()

    try {
      if (format === 'odk') {
        const odk = await OdkAvatar.fromBytes(bytes, entry?.mmlAttachments)
        if (this.disposed || this.previewMode !== 'odk') {
          odk.dispose()
          return
        }
        this.odkPreview = odk
        this.avatar = odk.root
        this.pivot!.add(odk.root)
        this.subjectSize = alignPreviewAvatarToGround(odk.root, 'odk')
      } else {
        const vrm = await VrmAvatar.fromBytes(bytes)
        if (this.disposed || this.previewMode !== 'vrm') {
          vrm.dispose()
          return
        }
        this.vrmPreview = vrm
        this.avatar = vrm.root
        this.pivot!.add(vrm.root)
        this.subjectSize = alignPreviewAvatarToGround(vrm.root, 'vrm', vrm.vrm)
      }

      this.frameCamera(this.subjectSize)
    } catch (err) {
      console.warn('[backpack] custom avatar preview failed', err)
      this.previewMode = 'dcl'
      await this.loadAvatarModel()
    }
  }

  private tick(now: number): void {
    if (this.disposed) return
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000)
    this.lastFrame = now

    if (this.pivot) this.pivot.rotation.y += delta * 0.35

    if (this.previewMode === 'vrm') {
      this.vrmPreview?.update(delta)
    } else if (this.previewMode === 'odk') {
      this.odkPreview?.update(delta)
    } else {
      this.animations?.update(delta, {
        horizontalSpeed: 0,
        grounded: true,
        locomotionMode: 'walk',
        jumping: false,
        doubleJumping: false,
        falling: false
      })
    }

    if (this.renderer && this.scene && this.camera) {
      this.renderer.render(this.scene, this.camera)
    }
    this.raf = requestAnimationFrame((t) => this.tick(t))
  }

  private frameCamera(size: THREE.Vector3): void {
    if (!this.camera) return
    const lookY = size.y * 0.42
    const fovRad = THREE.MathUtils.degToRad(this.camera.fov)
    const aspect = Math.max(this.camera.aspect, 0.5)
    const pad = 0.92
    const fitHeight = ((size.y + 0.35) * pad) / (2 * Math.tan(fovRad / 2))
    const fitWidth = ((size.x + 0.5) * pad) / (2 * Math.tan(fovRad / 2) * aspect)
    const distance = Math.max(fitHeight, fitWidth, 1.5)
    this.camera.position.set(0, lookY, distance)
    this.camera.lookAt(0, lookY, 0)
    this.camera.updateProjectionMatrix()
  }

  private resizePreview(): void {
    const stage = this.root.querySelector('.backpack-view__avatar-stage') as HTMLElement
    if (!stage || !this.renderer || !this.camera) return
    const w = stage.clientWidth
    const h = stage.clientHeight
    if (w <= 0 || h <= 0) return
    this.renderer.setSize(w, h, false)
    this.camera.aspect = w / h
    this.frameCamera(this.subjectSize)
  }

  private clearAvatar(): void {
    this.pivot?.position.set(0, 0, 0)
    this.animations?.dispose()
    this.animations = null
    if (this.vrmPreview) {
      this.pivot?.remove(this.vrmPreview.root)
      this.vrmPreview.dispose()
      this.vrmPreview = null
      this.avatar = null
      return
    }
    if (this.odkPreview) {
      this.pivot?.remove(this.odkPreview.root)
      this.odkPreview.dispose()
      this.odkPreview = null
      this.avatar = null
      return
    }
    if (!this.avatar || !this.pivot) return
    this.disposeGraph(this.avatar)
    this.pivot.remove(this.avatar)
    this.avatar = null
  }

  private disposeGraph(root: THREE.Object3D): void {
    if (root.name === 'custom-vrm') {
      disposeVrmRoot(null, root)
      return
    }
    if (root.name === 'custom-odk') {
      disposeOdkRoot(root)
      return
    }
    disposeWearableInstance(root as THREE.Group)
  }

  dispose(): void {
    this.disposed = true
    cancelAnimationFrame(this.raf)
    this.resizeObserver?.disconnect()
    this.clearAvatar()
    if (this.renderer) {
      this.renderer.forceContextLoss()
      this.renderer.dispose()
    }
    this.previewCanvas?.remove()
  }
}