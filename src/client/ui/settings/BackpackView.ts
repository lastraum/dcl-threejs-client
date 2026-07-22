import * as THREE from 'three'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { assetUrnFromCompleteUrn, bodyShapeFromUrn, BODY_SHAPE_URN, PEER_URL } from '../../../avatar/constants'
import { AvatarAnimations } from '../../../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../../../avatar/AvatarComposer'
import { disposeWearableInstance } from '../../../avatar/loadWearable'
import type { AvatarProfile, WearableCategory } from '../../../avatar/types'
import { computeHiddenBy } from '../../../avatar/slots'
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
import { fetchProfileFaceUrl } from '../../../avatar/peerApi'
import {
  getEquippedCustomAvatar,
  setEquippedCustomAvatar
} from '../../../avatar/vrm/vrmEquipStorage'
import { setExtendedAvatarColor } from '../../../avatar/extendedColors'
import { backpackCategoryIcon } from './backpackCategoryIcons'
import {
  createColorPicker,
  makeThumbnailTinter,
  tintChannelForCategory,
  type ColorChannel
} from './backpackColorPicker'
import {
  filterBackpackWearables,
  loadBackpackWearables,
  loadBaseWearableCatalog,
  loadEquippedWearablesByCategory,
  mergeBaseIntoInventory,
  mergeEquippedIntoInventory,
  type BackpackWearableItem
} from './backpackWearables'
import {
  equipWearableOnProfile,
  isWearableEquipped,
  unequipWearableFromProfile
} from './profileWearableEquip'
import { profileDeployFingerprint } from '../../../avatar/deployProfile'
import {
  baseEmoteSlugFromRef,
  baseEmoteUrn,
  buildEmoteBackpackWheelSlots,
  emoteLabel,
  emoteWheelIndexToKey,
  emoteWheelKeyToIndex,
  loadResolvedProfileEmote,
  resolveProfileEmote
} from '../../../avatar/profileEmotes'
import {
  baseEmoteCatalogAsItems,
  filterBackpackEmotes,
  loadBackpackEmotes,
  type BackpackEmoteItem
} from './backpackEmotes'
import {
  equipEmoteOnProfile,
  isEmoteEquippedOnProfile,
  profileSlotsForEmote,
  unequipEmoteFromProfile
} from './profileEmoteEquip'
import { getSessionAssetCache } from '../../../rendering/AssetCache'
import {
  guessWearableRarity,
  sortWearablesByGroup,
  sortWearablesByRarity,
  wearableRarityBackground,
  wearableRarityLabel,
  WEARABLE_RARITY_COLORS
} from '../profile/wearableThumb'
import { annotateItemsWithCollections } from './wearableCollections'

type CategoryDef = { id: WearableCategory | 'all'; label: string }
type BackpackSubTab = 'wearables' | 'emotes' | 'vrm' | 'osa'
type BackpackSortMode = 'name' | 'rarity' | 'collection' | 'creator'
type GroupableItem = { collectionName?: string; creatorName?: string }

function parseSortMode(value: string): BackpackSortMode {
  return value === 'rarity' || value === 'collection' || value === 'creator' ? value : 'name'
}

const OSA_GRID_COLUMNS = 3
const OSA_GRID_ROWS = 3
const OSA_ITEMS_PER_PAGE = OSA_GRID_COLUMNS * OSA_GRID_ROWS
/** Same 3×3 board as wearables inventory. */
const EMOTE_ITEMS_PER_PAGE = 9

type BackpackViewOptions = {
  onVrmEquipChange?: () => void | Promise<void>
}

const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M4 4l16 16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M10.6 6.3A9.6 9.6 0 0 1 12 6.2c4.2 0 7.6 2.9 9.3 5.8-.6 1-1.4 2-2.4 2.9M14.1 14a3 3 0 0 1-4.2-4.2M6.4 7.6C4.7 8.8 3.5 10.5 2.7 12c1.7 2.9 5.1 5.8 9.3 5.8 1 0 2-.2 2.9-.5" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`
const EYE_ON_SVG = `<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M2.7 12C4.4 9.1 7.8 6.2 12 6.2s7.6 2.9 9.3 5.8c-1.7 2.9-5.1 5.8-9.3 5.8S4.4 14.9 2.7 12z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><circle cx="12" cy="12" r="2.6" fill="currentColor"/></svg>`

// Ordered in 2-column rail rows: avatar (body/hair), face features, clothing, accessories.
const CATEGORIES: CategoryDef[] = [
  { id: 'all', label: 'All' },
  { id: 'body_shape', label: 'Body' },
  { id: 'hair', label: 'Hair' },
  { id: 'eyes', label: 'Eyes' },
  { id: 'eyebrows', label: 'Eyebrows' },
  { id: 'mouth', label: 'Mouth' },
  { id: 'facial_hair', label: 'Facial Hair' },
  { id: 'upper_body', label: 'Upper Body' },
  { id: 'lower_body', label: 'Lower Body' },
  { id: 'hands_wear', label: 'Handwear' },
  { id: 'feet', label: 'Feet' },
  { id: 'eyewear', label: 'Eyewear' },
  { id: 'hat', label: 'Hat' },
  { id: 'earring', label: 'Earring' },
  { id: 'mask', label: 'Mask' },
  { id: 'tiara', label: 'Tiara' },
  { id: 'top_head', label: 'Top Head' },
  { id: 'helmet', label: 'Helmet' },
  { id: 'skin', label: 'Skin' }
]

const ITEMS_PER_PAGE = 9
const PREVIEW_ZOOM_STEP = 1.1
/** Three scroll-in steps above 1.0 — closer default framing on the disc. */
const PREVIEW_ZOOM_DEFAULT = PREVIEW_ZOOM_STEP ** 3
const PREVIEW_ZOOM_MIN = 0.55
const PREVIEW_ZOOM_MAX = 2.8

export class BackpackView {
  readonly root: HTMLElement
  private session: SessionIdentity
  private readonly onVrmEquipChange?: () => void | Promise<void>
  /** Sub-header row; SettingsOverlay relocates it into the shared top bar. */
  private subHeaderEl: HTMLElement | null = null
  private activeSubTab: BackpackSubTab = 'wearables'
  private selectedCategory: WearableCategory | 'all' = 'all'
  private currentPage = 1
  private selectedItem: string | null = null
  private wearableItems: BackpackWearableItem[] = []
  private equippedByCategory = new Map<WearableCategory, BackpackWearableItem>()
  /** Hidden category → the equipped category that hides it (ADR-239, pre-forceRender). */
  private hiddenByCategory = new Map<WearableCategory, WearableCategory>()
  private wearablesLoading = false
  private wearablesError: string | null = null
  private wearablesLoadGen = 0
  private equippedLoadGen = 0
  private searchQuery = ''
  private sortMode: BackpackSortMode = 'name'
  /** Active collection/creator name filter (only while sortMode is collection/creator). */
  private groupFilter: string | null = null
  private previewZoom = PREVIEW_ZOOM_DEFAULT
  private orbitYaw = 0
  private dragPointerId: number | null = null
  private dragLastX = 0
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
  /** Snapshot of equipped wearables when the view opened / last committed. */
  private baselineWearablesKey = ''
  private emotePage = 1
  private selectedEmoteId: string | null = null
  private selectedEmoteSlotKey: string | null = null
  private emotePlayGen = 0
  private emoteItems: BackpackEmoteItem[] = []
  private emotesLoading = false
  private emotesError: string | null = null
  private emotesLoadGen = 0

  constructor(session: SessionIdentity, options: BackpackViewOptions = {}) {
    this.session = session
    this.onVrmEquipChange = options.onVrmEquipChange
    this.baselineWearablesKey = this.wearablesKeyFromProfile()
    this.root = document.createElement('div')
    this.root.className = 'backpack-view'

    this.root.innerHTML = `
      <div class="backpack-view__sub-header">
        <div class="backpack-view__sub-tabs">
          <button class="backpack-view__sub-tab is-active" data-subtab="wearables">
            <span class="backpack-view__sub-tab-ico" aria-hidden="true">${backpackCategoryIcon('upper_body')}</span> Wearables
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
          <select class="backpack-view__sort" data-sort-select aria-label="Sort items">
            <option value="name" selected>Sort: A–Z</option>
            <option value="rarity">Sort: Rarest first</option>
            <option value="collection">Sort: Collection</option>
            <option value="creator">Sort: Creator</option>
          </select>
          <select class="backpack-view__sort backpack-view__group-filter" data-group-filter aria-label="Filter by collection or creator" hidden></select>
          <input class="backpack-view__search" type="text" placeholder="Search item" />
        </div>
      </div>
      <input type="file" accept=".vrm,.mml,model/vrm" class="backpack-view__vrm-file-input" hidden />
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
      <nav class="backpack-view__mobile-bar" aria-label="Backpack panels">
        <button type="button" class="backpack-view__mobile-bar-btn" data-mobile-drawer="equipped">
          <span class="backpack-view__mobile-bar-icon" aria-hidden="true">◎</span>
          <span>Equipped</span>
        </button>
        <button type="button" class="backpack-view__mobile-bar-btn" data-mobile-drawer="inventory">
          <span class="backpack-view__mobile-bar-icon" aria-hidden="true">☰</span>
          <span>Inventory</span>
        </button>
      </nav>
      <div class="backpack-view__mobile-scrim" data-mobile-scrim hidden></div>
      <aside class="backpack-view__mobile-drawer" data-mobile-drawer-panel="equipped" hidden>
        <header class="backpack-view__mobile-drawer-head">
          <h3 class="backpack-view__mobile-drawer-title">Equipped</h3>
          <button type="button" class="backpack-view__mobile-drawer-close" data-mobile-drawer-close aria-label="Close">×</button>
        </header>
        <div class="backpack-view__mobile-drawer-body">
          <div class="backpack-view__mobile-equipped" data-mobile-equipped-list role="list"></div>
        </div>
      </aside>
      <aside class="backpack-view__mobile-drawer backpack-view__mobile-drawer--inventory" data-mobile-drawer-panel="inventory" hidden>
        <header class="backpack-view__mobile-drawer-head" data-mobile-inv-head>
          <button
            type="button"
            class="backpack-view__mobile-inv-back"
            data-mobile-inv-back
            hidden
            aria-label="Back to inventory"
          >
            ‹ Back
          </button>
          <h3 class="backpack-view__mobile-drawer-title" data-mobile-inv-title>Inventory</h3>
          <button type="button" class="backpack-view__mobile-drawer-close" data-mobile-drawer-close aria-label="Close">×</button>
        </header>
        <div class="backpack-view__mobile-drawer-body backpack-view__mobile-drawer-body--inventory">
          <div class="backpack-view__mobile-inv-list" data-mobile-inv-list>
            <div class="backpack-view__mobile-inv-toolbar">
              <input
                class="backpack-view__mobile-inv-search"
                type="search"
                data-mobile-inv-search
                placeholder="Search items"
                autocomplete="off"
                enterkeyhint="search"
              />
              <select class="backpack-view__mobile-inv-filter" data-mobile-inv-filter aria-label="Category filter">
                ${CATEGORIES.map(
                  (c) =>
                    `<option value="${c.id}"${c.id === 'all' ? ' selected' : ''}>${c.label}</option>`
                ).join('')}
              </select>
              <select class="backpack-view__mobile-inv-filter" data-mobile-inv-sort aria-label="Sort items">
                <option value="name" selected>A–Z</option>
                <option value="rarity">Rarest</option>
                <option value="collection">Collection</option>
                <option value="creator">Creator</option>
              </select>
              <select class="backpack-view__mobile-inv-filter backpack-view__mobile-inv-filter--group" data-mobile-inv-group aria-label="Filter by collection or creator" hidden></select>
            </div>
            <div class="backpack-view__mobile-inv-grid backpack-view__grid" data-mobile-inv-grid></div>
            <div class="backpack-view__mobile-inv-pagination backpack-view__pagination" data-mobile-inv-pagination></div>
          </div>
          <div class="backpack-view__mobile-inv-detail" data-mobile-inv-detail hidden></div>
        </div>
      </aside>
    `

    this.vrmFileInput = this.root.querySelector('.backpack-view__vrm-file-input')
    this.subHeaderEl = this.root.querySelector('.backpack-view__sub-header')
    this.buildCategories()
    void this.loadWearables()
    void this.loadEquippedWearables()
    void this.loadEmotes()
    this.initAvatarPreview()
    this.wireWearablesSearch()
    this.wireMobileInventoryToolbar()
    this.wireSubTabs()
    this.wireVrmDropZone()
    this.wireMmlUrlImport()
    this.wireOsaSearch()
    this.wireMobileDrawers()
    void this.refreshVrmLibrary()
  }

  private mobileDrawer: 'equipped' | 'inventory' | null = null

  private wireMobileDrawers(): void {
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mobile-drawer]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset.mobileDrawer as 'equipped' | 'inventory' | undefined
        if (!id) return
        if (this.mobileDrawer === id) this.closeMobileDrawer()
        else this.openMobileDrawer(id)
      })
    }
    this.root.querySelectorAll('[data-mobile-drawer-close]').forEach((el) => {
      el.addEventListener('click', () => this.closeMobileDrawer())
    })
    this.root.querySelector('[data-mobile-scrim]')?.addEventListener('click', () => this.closeMobileDrawer())
    this.root.querySelector('[data-mobile-inv-back]')?.addEventListener('click', () => {
      this.hideMobileInventoryDetail()
    })
  }

  /** Query root + the (possibly relocated) sub-header row. */
  private q<T extends Element = Element>(selector: string): T | null {
    const hit = this.root.querySelector(selector)
    if (hit) return hit as T
    return (this.subHeaderEl?.querySelector(selector) ?? null) as T | null
  }

  private qa<T extends Element = Element>(selector: string): T[] {
    const out = [...this.root.querySelectorAll(selector)] as T[]
    if (this.subHeaderEl && !this.root.contains(this.subHeaderEl)) {
      out.push(...([...this.subHeaderEl.querySelectorAll(selector)] as T[]))
    }
    return out
  }

  private wireMobileInventoryToolbar(): void {
    const search = this.root.querySelector('[data-mobile-inv-search]') as HTMLInputElement | null
    const filter = this.root.querySelector('[data-mobile-inv-filter]') as HTMLSelectElement | null
    search?.addEventListener('input', () => {
      this.searchQuery = search.value
      this.currentPage = 1
      // Keep desktop search in sync when present.
      const desktop = this.q<HTMLInputElement>('.backpack-view__search')
      if (desktop && desktop !== search) desktop.value = search.value
      if (this.activeSubTab === 'wearables') this.renderGrid()
      if (this.activeSubTab === 'emotes') {
        this.emotePage = 1
        this.renderEmoteGrid()
      }
    })
    filter?.addEventListener('change', () => {
      const cat = filter.value as WearableCategory | 'all'
      this.selectedCategory = cat
      this.currentPage = 1
      this.selectedItem = null
      this.syncDesktopCategoryActive()
      this.renderGrid()
      this.hideMobileInventoryDetail()
      this.updateCategoryEquipped()
    })
    const sort = this.root.querySelector('[data-mobile-inv-sort]') as HTMLSelectElement | null
    sort?.addEventListener('change', () => {
      this.setSortMode(parseSortMode(sort.value))
    })
    const group = this.root.querySelector('[data-mobile-inv-group]') as HTMLSelectElement | null
    group?.addEventListener('change', () => {
      this.setGroupFilter(group.value || null)
    })
  }

  private setMobileInvHeader(mode: 'list' | 'detail', title = 'Inventory'): void {
    const head = this.root.querySelector('[data-mobile-inv-head]') as HTMLElement | null
    const back = this.root.querySelector('[data-mobile-inv-back]') as HTMLElement | null
    const titleEl = this.root.querySelector('[data-mobile-inv-title]') as HTMLElement | null
    head?.classList.toggle('backpack-view__mobile-drawer-head--detail', mode === 'detail')
    if (back) back.hidden = mode !== 'detail'
    if (titleEl) titleEl.textContent = title
  }

  private hideMobileInventoryDetail(): void {
    const list = this.root.querySelector('[data-mobile-inv-list]') as HTMLElement | null
    const detail = this.root.querySelector('[data-mobile-inv-detail]') as HTMLElement | null
    if (list) list.hidden = false
    if (detail) {
      detail.hidden = true
      detail.innerHTML = ''
    }
    this.setMobileInvHeader('list')
  }

  private syncDesktopCategoryActive(): void {
    const container = this.root.querySelector('.backpack-view__categories')
    if (!container) return
    for (const btn of container.querySelectorAll<HTMLElement>('.backpack-view__cat-row')) {
      btn.classList.toggle('is-active', btn.dataset.category === this.selectedCategory)
    }
  }

  private syncMobileInventoryToolbar(): void {
    const search = this.root.querySelector('[data-mobile-inv-search]') as HTMLInputElement | null
    const filter = this.root.querySelector('[data-mobile-inv-filter]') as HTMLSelectElement | null
    const sort = this.root.querySelector('[data-mobile-inv-sort]') as HTMLSelectElement | null
    if (search) search.value = this.searchQuery
    if (filter) filter.value = this.selectedCategory
    if (sort) sort.value = this.sortMode
  }

  private openMobileDrawer(id: 'equipped' | 'inventory'): void {
    this.mobileDrawer = id
    this.root.classList.toggle('backpack-view--drawer-equipped', id === 'equipped')
    this.root.classList.toggle('backpack-view--drawer-inventory', id === 'inventory')
    const scrim = this.root.querySelector('[data-mobile-scrim]') as HTMLElement | null
    if (scrim) scrim.hidden = false
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-mobile-drawer-panel]')) {
      panel.hidden = panel.dataset.mobileDrawerPanel !== id
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mobile-drawer]')) {
      btn.classList.toggle('is-active', btn.dataset.mobileDrawer === id)
    }
    if (id === 'equipped') this.renderMobileEquippedList()
    if (id === 'inventory') {
      this.syncMobileInventoryToolbar()
      this.renderGrid()
      // Always land on the grid; item tap drills into detail.
      this.hideMobileInventoryDetail()
    }
  }

  private closeMobileDrawer(): void {
    this.mobileDrawer = null
    this.hideMobileInventoryDetail()
    this.root.classList.remove('backpack-view--drawer-equipped', 'backpack-view--drawer-inventory')
    const scrim = this.root.querySelector('[data-mobile-scrim]') as HTMLElement | null
    if (scrim) scrim.hidden = true
    for (const panel of this.root.querySelectorAll<HTMLElement>('[data-mobile-drawer-panel]')) {
      panel.hidden = true
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-mobile-drawer]')) {
      btn.classList.remove('is-active')
    }
  }

  /** Mobile Equipped sheet — one row per wearable slot from `equippedByCategory`. */
  private renderMobileEquippedList(): void {
    const list = this.root.querySelector('[data-mobile-equipped-list]') as HTMLElement | null
    if (!list) return

    const slots = CATEGORIES.filter((c) => c.id !== 'all') as Array<{
      id: WearableCategory
      label: string
    }>

    list.innerHTML = ''
    for (const cat of slots) {
      const item = this.equippedByCategory.get(cat.id)
      const rarity = item ? item.rarity || guessWearableRarity(item.urn) : null
      const rarityBg = rarity ? wearableRarityBackground(rarity) : ''
      const rarityColor = rarity
        ? (WEARABLE_RARITY_COLORS[rarity] ?? WEARABLE_RARITY_COLORS.common)
        : ''
      const isSelected = item ? this.isSameWearableUrn(item.urn, this.selectedItem) : false

      const row = document.createElement('div')
      row.className =
        'backpack-view__mobile-equipped-row' +
        (item ? ' is-filled' : ' is-empty') +
        (isSelected ? ' is-selected' : '')
      row.setAttribute('role', 'listitem')
      row.dataset.category = cat.id

      row.innerHTML = `
        <span class="backpack-view__mobile-equipped-icon" aria-hidden="true">${backpackCategoryIcon(cat.id)}</span>
        <div class="backpack-view__mobile-equipped-thumb"${rarityBg ? ` style="background:${rarityBg}"` : ''}>
          ${
            item
              ? `<img src="${this.escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" decoding="async" />`
              : `<span class="backpack-view__mobile-equipped-empty-mark">—</span>`
          }
        </div>
        <div class="backpack-view__mobile-equipped-meta">
          <span class="backpack-view__mobile-equipped-slot">${this.escapeHtml(cat.label)}</span>
          <span class="backpack-view__mobile-equipped-name"${rarityColor ? ` style="color:${rarityColor}"` : ''}>
            ${item ? this.escapeHtml(item.name) : 'Empty'}
          </span>
        </div>
        ${
          item
            ? `<button type="button" class="backpack-view__mobile-equipped-unequip" data-unequip-urn="${this.escapeHtml(item.urn)}" aria-label="Unequip ${this.escapeHtml(item.name)}">Unequip</button>`
            : `<button type="button" class="backpack-view__mobile-equipped-browse" data-browse-category="${cat.id}">Browse</button>`
        }
      `

      if (item) {
        row.addEventListener('click', (e) => {
          if ((e.target as HTMLElement).closest('[data-unequip-urn]')) return
          this.selectedItem = item.urn
          this.selectedCategory = cat.id
          this.renderMobileEquippedList()
          this.updateCategoryEquipped()
          // Keep drawer open so user can unequip; avatar already shows current outfit.
        })
        row.querySelector('[data-unequip-urn]')?.addEventListener('click', (e) => {
          e.stopPropagation()
          void this.unequipWearable(item)
        })
      } else {
        row.querySelector('[data-browse-category]')?.addEventListener('click', (e) => {
          e.stopPropagation()
          this.selectCategory(cat.id)
          this.openMobileDrawer('inventory')
        })
      }

      list.appendChild(row)
    }
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

  private wireWearablesSearch(): void {
    const input = this.root.querySelector(
      '.backpack-view__sub-header .backpack-view__search'
    ) as HTMLInputElement | null
    input?.addEventListener('input', () => {
      this.searchQuery = input.value
      this.currentPage = 1
      this.emotePage = 1
      const mobile = this.root.querySelector('[data-mobile-inv-search]') as HTMLInputElement | null
      if (mobile) mobile.value = input.value
      if (this.activeSubTab === 'wearables') this.renderGrid()
      if (this.activeSubTab === 'emotes') this.renderEmoteGrid()
    })
    const sort = this.root.querySelector('[data-sort-select]') as HTMLSelectElement | null
    sort?.addEventListener('change', () => {
      this.setSortMode(parseSortMode(sort.value))
    })
    const group = this.root.querySelector('[data-group-filter]') as HTMLSelectElement | null
    group?.addEventListener('change', () => {
      this.setGroupFilter(group.value || null)
    })
  }

  /** Grid ordering for wearables + emotes; both desktop and mobile controls funnel here. */
  private setSortMode(mode: BackpackSortMode): void {
    if (mode === this.sortMode) return
    this.sortMode = mode
    this.groupFilter = null
    this.currentPage = 1
    this.emotePage = 1
    for (const sel of this.qa<HTMLSelectElement>('[data-sort-select], [data-mobile-inv-sort]')) {
      sel.value = mode
    }
    if (this.activeSubTab === 'wearables') this.renderGrid()
    if (this.activeSubTab === 'emotes') this.renderEmoteGrid()
  }

  private setGroupFilter(value: string | null): void {
    const next = value || null
    if (next === this.groupFilter) return
    this.groupFilter = next
    this.currentPage = 1
    this.emotePage = 1
    if (this.activeSubTab === 'wearables') this.renderGrid()
    if (this.activeSubTab === 'emotes') this.renderEmoteGrid()
  }

  /** Apply the active sort to an already-filtered item list (name order is load order). */
  private sortItems<T extends { name: string; rarity: string } & GroupableItem>(items: T[]): T[] {
    if (this.sortMode === 'rarity') return sortWearablesByRarity(items)
    if (this.sortMode === 'collection') return sortWearablesByGroup(items, (i) => i.collectionName)
    if (this.sortMode === 'creator') return sortWearablesByGroup(items, (i) => i.creatorName)
    return items
  }

  /** Narrow to the collection/creator picked in the group-filter dropdown, if any. */
  private applyGroupFilter<T extends GroupableItem>(items: T[]): T[] {
    if (!this.groupFilter) return items
    if (this.sortMode === 'collection') {
      return items.filter((i) => i.collectionName === this.groupFilter)
    }
    if (this.sortMode === 'creator') {
      return items.filter((i) => i.creatorName === this.groupFilter)
    }
    return items
  }

  /** Category + search + group filtered, sorted wearables (single source for grid + slot focus). */
  private visibleWearables(
    category: WearableCategory | 'all' = this.selectedCategory
  ): BackpackWearableItem[] {
    return this.sortItems(
      this.applyGroupFilter(filterBackpackWearables(this.wearableItems, category, this.searchQuery))
    )
  }

  private visibleEmotes(): BackpackEmoteItem[] {
    return this.sortItems(this.applyGroupFilter(filterBackpackEmotes(this.emoteItems, this.searchQuery)))
  }

  /**
   * Rebuild the collection/creator filter dropdowns (desktop + mobile). Hidden
   * unless sorting by collection or creator; options reflect the current
   * category + search scope with per-group counts.
   */
  private syncGroupControls(): void {
    const selects = this.qa<HTMLSelectElement>('[data-group-filter], [data-mobile-inv-group]')
    if (!selects.length) return
    const grouping = this.sortMode === 'collection' || this.sortMode === 'creator'
    if (!grouping || this.activeSubTab === 'vrm' || this.activeSubTab === 'osa') {
      for (const sel of selects) sel.hidden = true
      return
    }

    const items: GroupableItem[] =
      this.activeSubTab === 'emotes'
        ? filterBackpackEmotes(this.emoteItems, this.searchQuery)
        : filterBackpackWearables(this.wearableItems, this.selectedCategory, this.searchQuery)
    const byCollection = this.sortMode === 'collection'
    const counts = new Map<string, number>()
    for (const item of items) {
      const name = byCollection ? item.collectionName : item.creatorName
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    const names = [...counts.keys()].sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    )
    if (this.groupFilter && !counts.has(this.groupFilter)) this.groupFilter = null

    const allLabel = byCollection
      ? `All collections (${names.length})`
      : `All creators (${names.length})`
    const html =
      `<option value="">${this.escapeHtml(allLabel)}</option>` +
      names
        .map(
          (n) =>
            `<option value="${this.escapeHtml(n)}">${this.escapeHtml(n)} (${counts.get(n)})</option>`
        )
        .join('')
    for (const sel of selects) {
      sel.hidden = false
      sel.innerHTML = html
      sel.value = this.groupFilter ?? ''
    }
  }

  updateSession(session: SessionIdentity): void {
    this.session = session
    this.baselineWearablesKey = this.wearablesKeyFromProfile()
    void this.loadWearables()
    void this.loadEquippedWearables()
    void this.loadEmotes()
    void this.refreshVrmLibrary()
    if (this.activeSubTab === 'wearables' || this.activeSubTab === 'emotes') {
      void this.loadAvatarModel()
    }
  }

  /** Open a sub-tab (wearables / emotes / …) from external callers (emote wheel Customize). */
  setSubTab(tab: BackpackSubTab): void {
    if (tab === this.activeSubTab) {
      this.applySubTabLayout()
      return
    }
    this.activeSubTab = tab
    const subTabs = this.root.querySelectorAll('.backpack-view__sub-tab')
    subTabs.forEach((b) => {
      const el = b as HTMLElement
      el.classList.toggle('is-active', el.dataset.subtab === tab)
    })
    // Sub-header may live in settings overlay header slot.
    if (this.subHeaderEl && !this.root.contains(this.subHeaderEl)) {
      this.subHeaderEl.querySelectorAll('.backpack-view__sub-tab').forEach((b) => {
        const el = b as HTMLElement
        el.classList.toggle('is-active', el.dataset.subtab === tab)
      })
    }
    this.applySubTabLayout()
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
    const wearablesToolbar = this.q<HTMLElement>('.backpack-view__toolbar--wearables')!
    const wearablesMidTabs = this.root.querySelector('.backpack-view__middle-tabs--wearables') as HTMLElement
    const vrmMidTabs = this.root.querySelector('.backpack-view__middle-tabs--vrm') as HTMLElement
    const osaMidTabs = this.root.querySelector('.backpack-view__middle-tabs--osa') as HTMLElement
    const dropHint = this.root.querySelector('.backpack-view__vrm-drop-hint') as HTMLElement
    const categories = this.root.querySelector('.backpack-view__categories') as HTMLElement
    const gridArea = this.root.querySelector('.backpack-view__grid-area') as HTMLElement
    const isVrm = this.activeSubTab === 'vrm'
    const isOsa = this.activeSubTab === 'osa'
    const isEmotes = this.activeSubTab === 'emotes'
    const isAvatarLibraryTab = isVrm || isOsa

    this.root.classList.toggle('backpack-view--vrm', isVrm)
    this.root.classList.toggle('backpack-view--osa', isOsa)
    this.root.classList.toggle('backpack-view--emotes', isEmotes)
    // Keep search on emotes; hide filter+search only for VRM/OSA library tabs.
    wearablesToolbar.hidden = isAvatarLibraryTab
    wearablesMidTabs.hidden = isAvatarLibraryTab || isEmotes
    vrmMidTabs.hidden = !isVrm
    osaMidTabs.hidden = !isOsa
    dropHint.hidden = !isVrm
    // Emotes reuses the left rail for wheel slots (not wearable categories).
    categories.hidden = isAvatarLibraryTab
    gridArea?.classList.remove('is-dragover')

    if (isVrm) {
      this.renderVrmGrid()
      void this.loadCustomAvatarPreview(this.selectedVrmHash)
    } else if (isOsa) {
      void this.ensureOsaCatalog()
    } else if (isEmotes) {
      if (!this.emoteItems.length && !this.emotesLoading) void this.loadEmotes()
      this.renderEmotesUi()
      void this.loadAvatarModel()
    } else if (this.activeSubTab === 'wearables') {
      this.buildCategories()
      this.renderGrid()
      void this.loadAvatarModel()
    }
  }

  private renderEmotesUi(): void {
    if (this.activeSubTab !== 'emotes' || this.disposed) return
    this.renderEmoteSlots()
    this.renderEmoteGrid()
    this.renderEmoteDetail(this.selectedEmoteId)
  }

  private async loadEmotes(): Promise<void> {
    const gen = ++this.emotesLoadGen
    this.emotesLoading = true
    this.emotesError = null
    if (this.activeSubTab === 'emotes') this.renderEmoteGrid()

    try {
      const address = this.resolveWearablesAddress()
      const profile = this.session.getProfile()
      const equipped = (profile?.emotes ?? []).map((e) => e.urn).filter(Boolean)
      const items = await loadBackpackEmotes(
        address,
        this.session.getLambdasUrl(),
        equipped,
        PEER_URL
      )
      if (gen !== this.emotesLoadGen || this.disposed) return
      this.emoteItems = items.length ? items : baseEmoteCatalogAsItems()
      void this.annotateEmoteCollections(gen)
      this.emotesError = null
    } catch (err) {
      if (gen !== this.emotesLoadGen || this.disposed) return
      this.emoteItems = baseEmoteCatalogAsItems()
      this.emotesError = err instanceof Error ? err.message : String(err)
      console.warn('[backpack] emote inventory failed — base catalog only', err)
    } finally {
      if (gen === this.emotesLoadGen) {
        this.emotesLoading = false
        if (this.activeSubTab === 'emotes') this.renderEmotesUi()
      }
    }
  }

  private emoteMatches(a: string, b: string): boolean {
    if (!a || !b) return false
    if (a.toLowerCase() === b.toLowerCase()) return true
    const sa = baseEmoteSlugFromRef(a)
    const sb = baseEmoteSlugFromRef(b)
    if (sa && sb && sa === sb) return true
    return assetUrnFromCompleteUrn(a) === assetUrnFromCompleteUrn(b)
  }

  private findEmoteItem(emoteId: string): BackpackEmoteItem | null {
    return this.emoteItems.find((e) => this.emoteMatches(e.urn, emoteId)) ?? null
  }

  /** Prefer inventory/Catalyst display name over URN tail (token ids look like "105312291…"). */
  private emoteDisplayName(emoteId: string, fallbackLabel?: string): string {
    const inv = this.findEmoteItem(emoteId)
    if (inv?.name?.trim()) {
      const raw = inv.name.trim()
      // Ignore pure-numeric labels that are really token fragments.
      if (!/^\d{6,}$/.test(raw)) return raw
    }
    const fromHelper = emoteLabel(emoteId, fallbackLabel)
    if (fromHelper && !/^\d{6,}/.test(fromHelper)) return fromHelper
    return fallbackLabel?.trim() || inv?.name || fromHelper || 'Emote'
  }

  /** Badge slot for grid cards — only profile-assigned wheel entries (not in-world defaults). */
  private emoteSlotBadgeKey(emoteId: string): string | null {
    const profile = this.session.getProfile()
    if (!profile) return null
    const slots = profileSlotsForEmote(profile, emoteId)
    if (!slots.length) return null
    return emoteWheelIndexToKey(slots[0]!)
  }

  private renderEmoteSlots(): void {
    const container = this.root.querySelector('.backpack-view__categories') as HTMLElement | null
    if (!container) return
    const profile = this.session.getProfile()
    const slots = buildEmoteBackpackWheelSlots(profile)

    container.innerHTML = ''
    container.classList.add('backpack-view__categories--emotes')

    for (const slot of slots) {
      const inv = slot.empty ? null : this.findEmoteItem(slot.id)
      const label = slot.empty ? 'Empty' : this.emoteDisplayName(slot.id, slot.label)
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className =
        'backpack-view__emote-slot' +
        (this.selectedEmoteSlotKey === slot.key ? ' is-active' : '') +
        (!slot.empty && this.selectedEmoteId && this.emoteMatches(this.selectedEmoteId, slot.id)
          ? ' is-selected-emote'
          : '') +
        (slot.empty ? ' is-empty' : '')
      btn.dataset.slotKey = slot.key
      btn.dataset.emoteId = slot.id
      btn.title = label
      const thumb = inv?.thumbnailUrl
        ? `<img class="backpack-view__emote-slot-img" src="${this.escapeHtml(inv.thumbnailUrl)}" alt="" />`
        : `<span class="backpack-view__emote-slot-thumb" aria-hidden="true">${slot.empty ? '—' : '💃'}</span>`
      btn.innerHTML = `
        <span class="backpack-view__emote-slot-num" aria-hidden="true">${this.escapeHtml(slot.key)}</span>
        <span class="backpack-view__emote-slot-label">${this.escapeHtml(label)}</span>
        ${thumb}
      `
      btn.addEventListener('click', () => {
        this.selectedEmoteSlotKey = slot.key
        if (!slot.empty) this.selectedEmoteId = slot.id
        // Select only — play via "Play preview" in the detail panel.
        this.renderEmotesUi()
      })
      container.appendChild(btn)
    }
  }

  /**
   * Emotes inventory — same 3×3 board + gap + empty slots as wearables {@link renderGrid}.
   * Uses `backpack-view__item` so spacing matches wearables exactly.
   */
  private renderEmoteGrid(): void {
    if (this.activeSubTab !== 'emotes') return
    const gridEl = this.root.querySelector('.backpack-view__middle .backpack-view__grid') as HTMLElement | null
    const paginationEl = this.root.querySelector(
      '.backpack-view__middle .backpack-view__pagination'
    ) as HTMLElement | null
    if (!gridEl || !paginationEl) return

    gridEl.innerHTML = ''
    gridEl.classList.remove('backpack-view__grid--emotes')
    paginationEl.innerHTML = ''

    if (this.emotesLoading && !this.emoteItems.length) {
      gridEl.innerHTML = `<p class="backpack-view__grid-status">Loading emotes…</p>`
      return
    }

    this.syncGroupControls()
    const catalog = this.visibleEmotes()
    if (!catalog.length) {
      gridEl.innerHTML = `<p class="backpack-view__grid-status${
        this.emotesError ? ' backpack-view__grid-status--error' : ''
      }">${this.escapeHtml(this.emotesError || 'No emotes found')}</p>`
      return
    }

    const totalPages = Math.max(1, Math.ceil(catalog.length / EMOTE_ITEMS_PER_PAGE))
    const page = Math.min(this.emotePage, totalPages)
    this.emotePage = page
    const start = (page - 1) * EMOTE_ITEMS_PER_PAGE
    const pageItems = catalog.slice(start, start + EMOTE_ITEMS_PER_PAGE)

    for (const item of pageItems) {
      const badgeKey = this.emoteSlotBadgeKey(item.urn)
      const isSelected = !!this.selectedEmoteId && this.emoteMatches(this.selectedEmoteId, item.urn)
      const rarity = item.rarity || guessWearableRarity(item.urn)
      const card = document.createElement('button')
      card.type = 'button'
      card.className =
        'backpack-view__item is-' +
        rarity +
        (isSelected ? ' is-selected' : '') +
        (badgeKey ? ' is-equipped' : '')
      card.dataset.emoteId = item.urn
      card.title = item.name
      card.style.setProperty('--wearable-rarity-bg', wearableRarityBackground(rarity))
      card.innerHTML = `<img class="backpack-view__item-img" src="${this.escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" />${
        badgeKey
          ? `<span class="backpack-view__item-amount" title="Wheel slot ${this.escapeHtml(badgeKey)}">${this.escapeHtml(badgeKey)}</span>`
          : ''
      }`
      card.addEventListener('click', () => {
        this.selectedEmoteId = item.urn
        // Select only — play via "Play preview" in the detail panel.
        this.renderEmotesUi()
      })
      gridEl.appendChild(card)
    }

    // Fixed 3×3 board — same empty fillers as wearables.
    const emptySlots = EMOTE_ITEMS_PER_PAGE - pageItems.length
    for (let i = 0; i < emptySlots; i++) {
      const empty = document.createElement('div')
      empty.className = 'backpack-view__item backpack-view__item--empty'
      empty.setAttribute('aria-hidden', 'true')
      gridEl.appendChild(empty)
    }

    if (totalPages > 1) {
      const prev = document.createElement('button')
      prev.type = 'button'
      prev.className = 'backpack-view__page-btn'
      prev.textContent = '‹'
      prev.disabled = page <= 1
      prev.addEventListener('click', () => {
        this.emotePage--
        this.renderEmoteGrid()
      })
      paginationEl.appendChild(prev)

      const firstBtn = Math.max(1, Math.min(page - 2, totalPages - 4))
      for (let i = firstBtn; i <= Math.min(totalPages, firstBtn + 4); i++) {
        const pageBtn = document.createElement('button')
        pageBtn.type = 'button'
        pageBtn.className = 'backpack-view__page-btn' + (i === page ? ' is-active' : '')
        pageBtn.textContent = String(i)
        pageBtn.addEventListener('click', () => {
          this.emotePage = i
          this.renderEmoteGrid()
        })
        paginationEl.appendChild(pageBtn)
      }

      const next = document.createElement('button')
      next.type = 'button'
      next.className = 'backpack-view__page-btn'
      next.textContent = '›'
      next.disabled = page >= totalPages
      next.addEventListener('click', () => {
        this.emotePage++
        this.renderEmoteGrid()
      })
      paginationEl.appendChild(next)
    }
  }

  private renderEmoteDetail(emoteId: string | null): void {
    const detailEl = this.root.querySelector('.backpack-view__detail') as HTMLElement | null
    if (!detailEl) return
    if (!emoteId) {
      detailEl.innerHTML = `<p class="backpack-view__detail-empty">Select an emote · click a wheel slot to choose equip target</p>`
      return
    }
    const profile = this.session.getProfile()
    const item = this.findEmoteItem(emoteId)
    const label = this.emoteDisplayName(emoteId)
    const urn = emoteId.startsWith('urn:') ? emoteId : baseEmoteUrn(emoteId)
    const rarity = item?.rarity || 'base'
    const rarityColor = WEARABLE_RARITY_COLORS[rarity] ?? WEARABLE_RARITY_COLORS.common
    const equipped = profile ? isEmoteEquippedOnProfile(profile, emoteId) : false
    const onSlots = profile ? profileSlotsForEmote(profile, emoteId) : []
    const targetKey =
      this.selectedEmoteSlotKey ??
      (onSlots[0] != null ? emoteWheelIndexToKey(onSlots[0]) : null) ??
      '1'
    const targetIndex = emoteWheelKeyToIndex(targetKey)
    const slotHint = equipped
      ? `On wheel · slot ${onSlots.map((i) => emoteWheelIndexToKey(i)).join(', ')}`
      : `Equip to slot ${targetKey}`
    const canEquip = !!profile && targetIndex >= 0

    detailEl.innerHTML = `
      <div class="backpack-view__detail-card backpack-view__detail-card--emote">
        ${
          item?.thumbnailUrl
            ? `<div class="backpack-view__detail-thumb" style="background:${wearableRarityBackground(rarity)}">
                <img class="backpack-view__detail-img" src="${this.escapeHtml(item.thumbnailUrl)}" alt="" />
              </div>`
            : `<div class="backpack-view__emote-detail-icon" aria-hidden="true">💃</div>`
        }
        <h3 class="backpack-view__detail-name">${this.escapeHtml(label)}</h3>
        <span class="backpack-view__detail-category">${this.escapeHtml(slotHint)}</span>
        <span class="backpack-view__detail-rarity" style="color:${rarityColor}">${this.escapeHtml(wearableRarityLabel(rarity))}</span>
        <p class="backpack-view__detail-urn">${this.escapeHtml(urn)}</p>
        <div class="backpack-view__wearable-actions">
          <button type="button" class="backpack-view__wearable-equip-btn" data-action="play-emote">
            Play preview
          </button>
          <button type="button" class="backpack-view__wearable-equip-btn" data-action="toggle-emote-equip" ${canEquip ? '' : 'disabled'}>
            ${equipped ? 'Unequip' : `Equip · slot ${this.escapeHtml(targetKey)}`}
          </button>
        </div>
      </div>
    `
    detailEl.querySelector('[data-action="play-emote"]')?.addEventListener('click', () => {
      void this.playBackpackEmote(emoteId)
    })
    detailEl.querySelector('[data-action="toggle-emote-equip"]')?.addEventListener('click', () => {
      if (!canEquip || !profile) return
      if (equipped) this.unequipEmote(emoteId)
      else this.equipEmote(emoteId, targetIndex)
    })
  }

  private equipEmote(emoteId: string, slotIndex: number): void {
    const profile = this.session.getProfile()
    if (!profile || slotIndex < 0) return
    const emotes = equipEmoteOnProfile(profile, emoteId, slotIndex)
    this.session.setProfile({ ...profile, emotes })
    this.selectedEmoteSlotKey = emoteWheelIndexToKey(slotIndex)
    this.selectedEmoteId = emoteId
    this.renderEmotesUi()
  }

  private unequipEmote(emoteId: string): void {
    const profile = this.session.getProfile()
    if (!profile) return
    const emotes = unequipEmoteFromProfile(profile, emoteId)
    this.session.setProfile({ ...profile, emotes })
    this.renderEmotesUi()
  }

  private async playBackpackEmote(emoteId: string): Promise<void> {
    const profile = this.session.getProfile()
    if (!profile || !this.animations) {
      // Ensure DCL avatar + mixer exist (e.g. switched from VRM).
      await this.loadAvatarModel()
    }
    if (!this.animations || this.disposed || this.activeSubTab !== 'emotes') return

    const gen = ++this.emotePlayGen
    const bodyShape = profile?.bodyShape ?? this.session.getProfile()?.bodyShape ?? 'male'
    try {
      const resolved = await resolveProfileEmote(emoteId, bodyShape, PEER_URL)
      if (gen !== this.emotePlayGen || this.disposed) return
      if (!resolved) {
        console.warn('[backpack] unknown emote', emoteId)
        return
      }
      const gltf = await loadResolvedProfileEmote(getSessionAssetCache(), resolved)
      if (gen !== this.emotePlayGen || this.disposed || !gltf || !this.animations) return
      this.animations.playProfileEmoteFromGltf(gltf, resolved.loop, resolved.urn)
    } catch (err) {
      if (gen === this.emotePlayGen) console.warn('[backpack] emote preview failed', err)
    }
  }

  private buildCategories(): void {
    const container = this.root.querySelector('.backpack-view__categories')!
    container.classList.remove('backpack-view__categories--emotes')
    container.innerHTML = ''
    for (const cat of CATEGORIES) {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className =
        'backpack-view__cat-row' +
        (cat.id === 'all' ? ' backpack-view__cat-row--all' : '') +
        (cat.id === this.selectedCategory ? ' is-active' : '')
      btn.dataset.category = cat.id
      btn.title = cat.label
      btn.innerHTML = `
        <span class="backpack-view__cat-icon">${backpackCategoryIcon(cat.id)}</span>
        <span class="backpack-view__cat-preview"></span>
      `
      this.applyCategoryPreview(btn, cat)
      btn.addEventListener('click', (e) => {
        container.querySelectorAll('.backpack-view__cat-row').forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')

        const preview = btn.querySelector('.backpack-view__cat-preview')
        const equipped = cat.id !== 'all' ? this.equippedByCategory.get(cat.id) : undefined
        const clickedEquippedPreview =
          !!equipped &&
          !!preview &&
          preview.classList.contains('backpack-view__cat-preview--equipped') &&
          (e.target === preview || preview.contains(e.target as Node))

        if (clickedEquippedPreview && cat.id !== 'all') {
          this.focusEquippedInCategory(cat.id)
        } else {
          this.selectCategory(cat.id)
        }
      })
      container.appendChild(btn)
    }
  }

  private isSameWearableUrn(a: string | null | undefined, b: string | null | undefined): boolean {
    if (!a || !b) return false
    return assetUrnFromCompleteUrn(a) === assetUrnFromCompleteUrn(b)
  }

  private selectCategory(cat: WearableCategory | 'all'): void {
    this.selectedCategory = cat
    this.currentPage = 1
    this.selectedItem = null
    const detailEl = this.root.querySelector('.backpack-view__detail')!
    detailEl.innerHTML = `<p class="backpack-view__detail-empty">No item selected</p>`
    this.syncMobileInventoryToolbar()
    this.syncDesktopCategoryActive()
    this.renderGrid()
    this.hideMobileInventoryDetail()
    this.updateCategoryEquipped()
  }

  /** Jump to the inventory page containing the equipped item and select it. */
  private focusEquippedInCategory(cat: WearableCategory): void {
    const equipped = this.equippedByCategory.get(cat)
    if (!equipped) {
      this.selectCategory(cat)
      return
    }

    this.selectedCategory = cat
    let items = this.visibleWearables(cat)
    let index = items.findIndex((i) => this.isSameWearableUrn(i.urn, equipped.urn))

    if (index < 0) {
      const invItem = this.wearableItems.find((i) => this.isSameWearableUrn(i.urn, equipped.urn))
      if (invItem && invItem.category !== cat) {
        invItem.category = cat
        items = this.visibleWearables(cat)
        index = items.findIndex((i) => this.isSameWearableUrn(i.urn, equipped.urn))
      }
    }

    const item = index >= 0 ? items[index]! : equipped

    if (index >= 0) {
      this.currentPage = Math.floor(index / ITEMS_PER_PAGE) + 1
    } else {
      this.currentPage = 1
    }

    this.selectedItem = item.urn
    this.syncMobileInventoryToolbar()
    this.syncDesktopCategoryActive()
    this.renderGrid()
    this.renderWearableDetail(item)
    this.renderMobileInventoryDetail(item)
    this.updateCategoryEquipped()
  }

  private applyCategoryPreview(btn: Element, cat: CategoryDef): void {
    const preview = btn.querySelector('.backpack-view__cat-preview') as HTMLElement | null
    if (!preview) return

    preview.className = 'backpack-view__cat-preview'
    preview.style.removeProperty('--wearable-rarity-bg')
    preview.style.removeProperty('--wearable-rarity-color')

    if (cat.id === 'all') {
      preview.innerHTML = `<span class="backpack-view__cat-all-label">All</span>`
      return
    }

    const item = this.equippedByCategory.get(cat.id)
    if (!item) {
      preview.classList.add('backpack-view__cat-preview--empty')
      preview.innerHTML = ''
      return
    }

    const rarity = item.rarity || guessWearableRarity(item.urn)
    preview.classList.add('backpack-view__cat-preview--equipped', `is-${rarity}`)
    preview.style.setProperty('--wearable-rarity-bg', wearableRarityBackground(rarity))
    preview.innerHTML = `<img class="backpack-view__cat-equipped" src="${this.escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" />`
    if (this.isSameWearableUrn(item.urn, this.selectedItem)) {
      preview.classList.add('is-selected')
    }

    const hiddenBy = this.hiddenByCategory.get(cat.id)
    if (hiddenBy) {
      const forced = this.isForceRendered(cat.id)
      preview.classList.add(
        forced ? 'backpack-view__cat-preview--forced' : 'backpack-view__cat-preview--hidden'
      )
      const hiderLabel = this.categoryLabel(hiddenBy)
      const title = forced
        ? `Hidden by ${hiderLabel} — shown by override. Click to re-hide.`
        : `Hidden by ${hiderLabel}. Click to show anyway.`
      const badge = document.createElement('button')
      badge.type = 'button'
      badge.className = 'backpack-view__cat-hidden-badge' + (forced ? ' is-on' : '')
      badge.title = title
      badge.setAttribute('aria-label', title)
      badge.innerHTML = forced ? EYE_ON_SVG : EYE_OFF_SVG
      badge.addEventListener('click', (e) => {
        e.stopPropagation()
        this.toggleForceRender(cat.id as WearableCategory)
      })
      preview.appendChild(badge)
    }
  }

  private isForceRendered(category: WearableCategory): boolean {
    return (this.session.getProfile()?.forceRender ?? []).includes(category)
  }

  /** Add/remove a category in profile.forceRender — renders a hidden wearable anyway. */
  private toggleForceRender(category: WearableCategory): void {
    const profile = this.session.getProfile()
    if (!profile) return
    const current = profile.forceRender ?? []
    const forceRender = current.includes(category)
      ? current.filter((c) => c !== category)
      : [...current, category]
    this.session.setProfile({ ...profile, forceRender })
    this.updateCategoryEquipped()
    const selected = this.selectedItem
      ? this.wearableItems.find((i) => this.isSameWearableUrn(i.urn, this.selectedItem))
      : null
    if (selected) this.renderWearableDetail(selected)
    // Preview updates locally; Catalyst deploy happens when the settings panel closes.
    void this.loadAvatarModel()
  }

  private updateCategoryEquipped(): void {
    this.hiddenByCategory = computeHiddenBy(
      Array.from(this.equippedByCategory.entries()).map(([category, item]) => ({
        category,
        hides: item.hides,
        replaces: item.replaces
      }))
    )
    const container = this.root.querySelector('.backpack-view__categories')
    if (container) {
      for (const cat of CATEGORIES) {
        const btn = container.querySelector(`[data-category="${cat.id}"]`)
        if (!btn) continue
        this.applyCategoryPreview(btn, cat)
      }
    }
    if (this.mobileDrawer === 'equipped') this.renderMobileEquippedList()
  }

  private async loadEquippedWearables(): Promise<void> {
    const profile = this.session.getProfile()
    const gen = ++this.equippedLoadGen
    if (!profile?.wearables?.length) {
      this.equippedByCategory = new Map()
      if (this.activeSubTab === 'wearables') this.updateCategoryEquipped()
      return
    }

    try {
      const map = await loadEquippedWearablesByCategory(profile, this.session.getLambdasUrl())
      if (gen !== this.equippedLoadGen || this.disposed) return
      this.equippedByCategory = map
    } catch (err) {
      console.warn('[backpack] equipped wearables metadata failed', err)
      if (gen !== this.equippedLoadGen || this.disposed) return
      this.equippedByCategory = new Map()
    }
    if (this.activeSubTab === 'wearables') this.updateCategoryEquipped()
  }

  private resolveWearablesAddress(): string | undefined {
    return this.session.getAddress() ?? getActiveProfileAddress()
  }

  private async loadWearables(): Promise<void> {
    const address = this.resolveWearablesAddress()
    const gen = ++this.wearablesLoadGen

    this.wearablesLoading = true
    this.wearablesError = null
    if (this.activeSubTab === 'wearables') this.renderGrid()

    try {
      const lambdasUrl = this.session.getLambdasUrl()
      // Wallet inventory + free base-avatars catalog in parallel. Guests get the
      // base catalog alone; a base-catalog failure degrades to owned-only.
      const [owned, baseCatalog] = await Promise.all([
        address ? loadBackpackWearables(address, lambdasUrl) : Promise.resolve([]),
        loadBaseWearableCatalog(lambdasUrl).catch((err) => {
          console.warn('[backpack] base wearables catalog failed', err)
          return [] as BackpackWearableItem[]
        })
      ])
      let items = mergeBaseIntoInventory(owned, baseCatalog)
      const profile = this.session.getProfile()
      if (profile?.wearables?.length) {
        items = mergeEquippedIntoInventory(items, profile.wearables)
      }
      if (gen !== this.wearablesLoadGen || this.disposed) return
      this.wearableItems = items
      void this.annotateWearableCollections(gen)
      this.wearablesError = items.length
        ? null
        : address
          ? 'No wearables found for this wallet'
          : 'Wearables catalog unavailable — connect a wallet or reopen the backpack to retry'
    } catch (err) {
      if (gen !== this.wearablesLoadGen || this.disposed) return
      this.wearableItems = []
      this.wearablesError = err instanceof Error ? err.message : String(err)
    } finally {
      if (gen === this.wearablesLoadGen) {
        this.wearablesLoading = false
        // Async completion must not stomp the Emotes / VRM / OSA UI.
        if (this.activeSubTab === 'wearables') this.renderGrid()
      }
    }
  }

  /**
   * Async collection/creator enrichment — runs after the grid first paints so
   * the marketplace directory fetch never delays the backpack. Re-renders when
   * names resolve (grid tooltips, group dropdown, detail pane).
   */
  private async annotateWearableCollections(gen: number): Promise<void> {
    try {
      const changed = await annotateItemsWithCollections(
        this.wearableItems,
        this.session.getLambdasUrl()
      )
      if (!changed || gen !== this.wearablesLoadGen || this.disposed) return
      if (this.activeSubTab === 'wearables') {
        this.renderGrid()
        const selected = this.selectedItem
          ? this.wearableItems.find((i) => this.isSameWearableUrn(i.urn, this.selectedItem!))
          : null
        if (selected) this.renderWearableDetail(selected)
      }
    } catch (err) {
      console.warn('[backpack] wearable collection info failed', err)
    }
  }

  private async annotateEmoteCollections(gen: number): Promise<void> {
    try {
      const changed = await annotateItemsWithCollections(
        this.emoteItems,
        this.session.getLambdasUrl()
      )
      if (!changed || gen !== this.emotesLoadGen || this.disposed) return
      if (this.activeSubTab === 'emotes') this.renderEmoteGrid()
    } catch (err) {
      console.warn('[backpack] emote collection info failed', err)
    }
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

  /** Desktop grid + optional mobile inventory grid (both stay in sync). */
  private inventoryGridTargets(): Array<{ grid: HTMLElement; pagination: HTMLElement }> {
    const targets: Array<{ grid: HTMLElement; pagination: HTMLElement }> = []
    const desktopGrid = this.root.querySelector(
      '.backpack-view__middle .backpack-view__grid'
    ) as HTMLElement | null
    const desktopPag = this.root.querySelector(
      '.backpack-view__middle .backpack-view__pagination'
    ) as HTMLElement | null
    if (desktopGrid && desktopPag) targets.push({ grid: desktopGrid, pagination: desktopPag })

    const mobileGrid = this.root.querySelector('[data-mobile-inv-grid]') as HTMLElement | null
    const mobilePag = this.root.querySelector('[data-mobile-inv-pagination]') as HTMLElement | null
    if (mobileGrid && mobilePag) targets.push({ grid: mobileGrid, pagination: mobilePag })

    return targets
  }

  private renderGrid(): void {
    // Wearables inventory only — never paint over emotes/VRM/OSA grids.
    if (this.activeSubTab !== 'wearables') return

    const targets = this.inventoryGridTargets()
    if (!targets.length) return

    for (const { grid, pagination } of targets) {
      grid.innerHTML = ''
      grid.classList.remove('backpack-view__grid--emotes')
      pagination.innerHTML = ''
    }

    const paintStatus = (html: string): void => {
      for (const { grid } of targets) grid.innerHTML = html
    }

    if (this.wearablesLoading) {
      paintStatus(`<p class="backpack-view__grid-status">Loading your wearables…</p>`)
      return
    }

    if (this.wearablesError && !this.wearableItems.length) {
      paintStatus(
        `<p class="backpack-view__grid-status backpack-view__grid-status--error">${this.escapeHtml(this.wearablesError)}</p>`
      )
      return
    }

    this.syncGroupControls()
    const items = this.visibleWearables()
    const totalPages = Math.max(1, Math.ceil(items.length / ITEMS_PER_PAGE))
    const page = Math.min(this.currentPage, totalPages)
    this.currentPage = page
    const start = (page - 1) * ITEMS_PER_PAGE
    const pageItems = items.slice(start, start + ITEMS_PER_PAGE)

    if (!pageItems.length) {
      paintStatus(`<p class="backpack-view__grid-status">No wearables in this category</p>`)
      return
    }

    for (const { grid, pagination } of targets) {
      const isMobileGrid = grid.hasAttribute('data-mobile-inv-grid')
      for (const item of pageItems) {
        const card = document.createElement('button')
        card.type = 'button'
        const isSelected = this.isSameWearableUrn(item.urn, this.selectedItem)
        const rarity = item.rarity || guessWearableRarity(item.urn)
        const gridProfile = this.session.getProfile()
        const equipped = gridProfile ? this.isItemEquipped(gridProfile, item) : false
        card.className =
          'backpack-view__item is-' +
          rarity +
          (isSelected ? ' is-selected' : '') +
          (equipped ? ' is-equipped' : '')
        card.style.setProperty('--wearable-rarity-bg', wearableRarityBackground(rarity))
        card.title = [
          item.name,
          item.collectionName,
          item.creatorName ? `by ${item.creatorName}` : null
        ]
          .filter(Boolean)
          .join('\n')
        card.innerHTML = `<img class="backpack-view__item-img" src="${this.escapeHtml(item.thumbnailUrl)}" alt="" loading="lazy" />${
          item.amount > 1
            ? `<span class="backpack-view__item-amount" title="${item.amount} in wallet">&times;${item.amount}</span>`
            : ''
        }`
        card.addEventListener('click', () => {
          this.selectItem(item)
          this.renderGrid()
        })
        grid.appendChild(card)
      }

      // Desktop keeps a fixed 3×3 board; mobile inventory only shows real items.
      if (!isMobileGrid) {
        const emptySlots = ITEMS_PER_PAGE - pageItems.length
        for (let i = 0; i < emptySlots; i++) {
          const empty = document.createElement('div')
          empty.className = 'backpack-view__item backpack-view__item--empty'
          empty.setAttribute('aria-hidden', 'true')
          grid.appendChild(empty)
        }
      }

      if (totalPages > 1) {
        const prev = document.createElement('button')
        prev.className = 'backpack-view__page-btn'
        prev.textContent = '‹'
        prev.disabled = page <= 1
        prev.addEventListener('click', () => {
          this.currentPage--
          this.renderGrid()
        })
        pagination.appendChild(prev)

        // Sliding 5-button window centered on the current page (base catalog can span 30+ pages).
        const firstBtn = Math.max(1, Math.min(page - 2, totalPages - 4))
        for (let i = firstBtn; i <= Math.min(totalPages, firstBtn + 4); i++) {
          const pageBtn = document.createElement('button')
          pageBtn.className = 'backpack-view__page-btn' + (i === page ? ' is-active' : '')
          pageBtn.textContent = String(i)
          pageBtn.addEventListener('click', () => {
            this.currentPage = i
            this.renderGrid()
          })
          pagination.appendChild(pageBtn)
        }

        const next = document.createElement('button')
        next.className = 'backpack-view__page-btn'
        next.textContent = '›'
        next.disabled = page >= totalPages
        next.addEventListener('click', () => {
          this.currentPage++
          this.renderGrid()
        })
        pagination.appendChild(next)
      }
    }
  }

  private renderMobileInventoryDetail(item: BackpackWearableItem | null): void {
    const list = this.root.querySelector('[data-mobile-inv-list]') as HTMLElement | null
    const el = this.root.querySelector('[data-mobile-inv-detail]') as HTMLElement | null
    if (!el) return

    if (!item) {
      this.hideMobileInventoryDetail()
      return
    }

    // Only drill into the detail panel while the inventory drawer is open on mobile.
    if (this.mobileDrawer !== 'inventory') {
      el.hidden = true
      el.innerHTML = ''
      if (list) list.hidden = false
      return
    }

    if (list) list.hidden = true
    el.hidden = false

    const profile = this.session.getProfile()
    const equipped = profile ? this.isItemEquipped(profile, item) : false
    const isBodyShape = item.category === 'body_shape'
    const rarity = item.rarity || guessWearableRarity(item.urn)
    const color = WEARABLE_RARITY_COLORS[rarity] ?? WEARABLE_RARITY_COLORS.common
    const fitsShape = this.itemFitsBodyShape(item)
    const canEquip =
      !!profile && item.category !== 'unknown' && (equipped || fitsShape) && !(isBodyShape && equipped)
    const equipLabel = isBodyShape ? (equipped ? 'Worn' : 'Wear') : equipped ? 'Unequip' : 'Equip'
    const category = this.categoryLabel(item.category)

    this.setMobileInvHeader('detail', 'Details')

    el.innerHTML = `
      <div class="backpack-view__mobile-inv-detail-card">
        <div class="backpack-view__mobile-inv-detail-thumb" style="background:${wearableRarityBackground(rarity)}">
          <img src="${this.escapeHtml(item.thumbnailUrl)}" alt="" />
        </div>
        <h4 class="backpack-view__mobile-inv-detail-name">${this.escapeHtml(item.name)}</h4>
        <span class="backpack-view__mobile-inv-detail-category">${this.escapeHtml(category)}</span>
        <span class="backpack-view__mobile-inv-detail-rarity" style="color:${color}">${this.escapeHtml(wearableRarityLabel(rarity))}</span>
        ${this.collectionLineHtml(item, 'backpack-view__detail-collection')}
        ${this.descriptionHtml(item)}
        ${this.hidesLineHtml(item)}
        ${this.shapeFitHtml(item, fitsShape, equipped)}
        <div class="backpack-view__mobile-inv-detail-actions">
          <button type="button" class="backpack-view__mobile-inv-detail-equip" data-mobile-equip ${canEquip ? '' : 'disabled'}>
            ${equipLabel}
          </button>
          <button type="button" class="backpack-view__mobile-inv-detail-market" disabled title="Coming soon">
            Marketplace
          </button>
        </div>
      </div>
    `
    el.querySelector('[data-mobile-equip]')?.addEventListener('click', () => {
      if (!canEquip) return
      if (isBodyShape) void this.switchBodyShape(item)
      else if (equipped) void this.unequipWearable(item)
      else void this.equipWearable(item)
    })

    this.appendColorPicker(el.querySelector('.backpack-view__mobile-inv-detail-card'), item, profile)
    this.hydrateCreatorFace(el)
  }

  private renderVrmGrid(skipThumbGen = false): void {
    const gridEl = this.root.querySelector('.backpack-view__middle .backpack-view__grid')!
    const paginationEl = this.root.querySelector(
      '.backpack-view__middle .backpack-view__pagination'
    )!
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
    const gridEl = this.root.querySelector('.backpack-view__middle .backpack-view__grid')!
    const paginationEl = this.root.querySelector(
      '.backpack-view__middle .backpack-view__pagination'
    )!
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
        this.qa('.backpack-view__sub-tab').forEach((btn) => {
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
      this.qa('.backpack-view__sub-tab').forEach((btn) => {
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
      this.qa('.backpack-view__sub-tab').forEach((btn) => {
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

  private selectItem(item: BackpackWearableItem): void {
    this.selectedItem = item.urn
    if (item.category !== 'unknown') this.selectedCategory = item.category
    this.syncMobileInventoryToolbar()
    this.renderWearableDetail(item)
    this.renderMobileInventoryDetail(item)
    this.updateCategoryEquipped()
  }

  private categoryLabel(category: BackpackWearableItem['category']): string {
    if (category === 'unknown') return 'Unknown'
    return CATEGORIES.find((c) => c.id === category)?.label ?? category.replace(/_/g, ' ')
  }

  /** False only when the item declares representations and none match the profile's shape. */
  private itemFitsBodyShape(item: BackpackWearableItem): boolean {
    // Both body-shape tiles are always selectable — they switch shape, not fill a slot.
    if (item.category === 'body_shape') return true
    if (!item.bodyShapes?.length) return true
    const profile = this.session.getProfile()
    if (!profile) return true
    const shapeUrn = BODY_SHAPE_URN[profile.bodyShape]?.toLowerCase()
    if (!shapeUrn) return true
    return item.bodyShapes.some((s) => s.trim().toLowerCase() === shapeUrn)
  }

  /** Equipped state, with body-shape tiles marked active when they match the profile's shape. */
  private isItemEquipped(profile: AvatarProfile, item: BackpackWearableItem): boolean {
    if (item.category === 'body_shape') return bodyShapeFromUrn(item.urn) === profile.bodyShape
    return isWearableEquipped(profile, item.urn)
  }

  /** "Collection · by Creator" caption for detail panes; empty until annotation resolves. */
  private collectionLineHtml(item: GroupableItem, className: string): string {
    if (!item.collectionName && !item.creatorName) return ''
    const creatorAddr = (item as { creatorAddress?: string }).creatorAddress?.toLowerCase()
    const faceSlot = creatorAddr
      ? `<span class="backpack-view__creator-face" data-creator-face="${this.escapeHtml(creatorAddr)}" aria-hidden="true"></span>`
      : ''
    const parts = [
      item.collectionName ? this.escapeHtml(item.collectionName) : null,
      item.creatorName ? `by ${faceSlot}${this.escapeHtml(item.creatorName)}` : null
    ].filter(Boolean)
    return `<span class="${className}">${parts.join(' · ')}</span>`
  }

  /** Fill creator pfp slots in a freshly rendered detail pane (async, globally cached). */
  private hydrateCreatorFace(scope: ParentNode | null): void {
    const slot = scope?.querySelector('[data-creator-face]') as HTMLElement | null
    if (!slot) return
    const addr = slot.getAttribute('data-creator-face') ?? ''
    if (!/^0x[a-f0-9]{40}$/.test(addr)) return
    void fetchProfileFaceUrl(addr).then((url) => {
      if (this.disposed || !url || !slot.isConnected) return
      slot.innerHTML = `<img src="${this.escapeHtml(url)}" alt="" loading="lazy" />`
      slot.classList.add('is-loaded')
    })
  }

  /** Creator-authored description paragraph; empty when metadata carries none. */
  private descriptionHtml(item: BackpackWearableItem): string {
    const desc = item.description?.trim()
    if (!desc) return ''
    return `<p class="backpack-view__detail-desc">${this.escapeHtml(desc)}</p>`
  }

  /** "Hides: Hat · Mask" caption from the wearable's hides/replaces lists (ADR-239). */
  private hidesLineHtml(item: BackpackWearableItem): string {
    const cats = [...new Set([...(item.hides ?? []), ...(item.replaces ?? [])])]
      .map((c) => c.trim().toLowerCase())
      .filter((c) => c && c !== item.category)
    if (!cats.length) return ''
    const labels = cats.map((c) =>
      this.escapeHtml(this.categoryLabel(c as BackpackWearableItem['category']))
    )
    return `<span class="backpack-view__detail-hides">Hides: ${labels.join(' · ')}</span>`
  }

  /** Visible body-shape pill for items that can't be equipped on the current shape. */
  private shapeFitHtml(item: BackpackWearableItem, fitsShape: boolean, equipped: boolean): string {
    if (fitsShape || equipped || item.category === 'body_shape') return ''
    return `<span class="backpack-view__detail-hidden">Not available for your body shape</span>`
  }

  private renderWearableDetail(item: BackpackWearableItem): void {
    const detailEl = this.root.querySelector('.backpack-view__detail')!
    const profile = this.session.getProfile()
    const equipped = profile ? this.isItemEquipped(profile, item) : false
    const isBodyShape = item.category === 'body_shape'
    const rarity = item.rarity || guessWearableRarity(item.urn)
    const color = WEARABLE_RARITY_COLORS[rarity] ?? WEARABLE_RARITY_COLORS.common
    const fitsShape = this.itemFitsBodyShape(item)
    // Body-shape tiles: the active shape is a no-op ("Worn"); the other is clickable to switch.
    const canEquip =
      !!profile && item.category !== 'unknown' && (equipped || fitsShape) && !(isBodyShape && equipped)
    const equipLabel = isBodyShape ? (equipped ? 'Worn' : 'Wear') : equipped ? 'Unequip' : 'Equip'
    const category = this.categoryLabel(item.category)

    const hiddenBy =
      equipped && item.category !== 'unknown' ? this.hiddenByCategory.get(item.category) : undefined
    const forced = hiddenBy ? this.isForceRendered(item.category as WearableCategory) : false
    const hiddenPill = hiddenBy
      ? `<span class="backpack-view__detail-hidden${forced ? ' backpack-view__detail-hidden--forced' : ''}">Hidden by ${this.escapeHtml(this.categoryLabel(hiddenBy))}${forced ? ' — shown by override' : ''}</span>`
      : ''

    detailEl.innerHTML = `
      <div class="backpack-view__detail-card">
        <div class="backpack-view__detail-thumb" style="background:${wearableRarityBackground(rarity)}">
          <img class="backpack-view__detail-img" src="${this.escapeHtml(item.thumbnailUrl)}" alt="" />
        </div>
        <h3 class="backpack-view__detail-name">${this.escapeHtml(item.name)}</h3>
        <span class="backpack-view__detail-category">${this.escapeHtml(category)}</span>
        <span class="backpack-view__detail-rarity" style="color:${color}">${this.escapeHtml(wearableRarityLabel(rarity))}</span>
        ${this.collectionLineHtml(item, 'backpack-view__detail-collection')}
        ${this.descriptionHtml(item)}
        ${this.hidesLineHtml(item)}
        ${item.amount > 1 ? `<span class="backpack-view__detail-owned">&times;${item.amount} in wallet</span>` : ''}
        ${hiddenPill}
        ${this.shapeFitHtml(item, fitsShape, equipped)}
        <div class="backpack-view__wearable-actions">
          <button type="button" class="backpack-view__wearable-equip-btn" data-action="toggle-equip" ${canEquip ? '' : 'disabled'}${!fitsShape && !equipped ? ' title="Not available for your body shape"' : ''}>
            ${equipLabel}
          </button>
          <button type="button" class="backpack-view__wearable-market-btn" disabled title="Coming soon">
            Marketplace
          </button>
        </div>
      </div>
    `

    detailEl.querySelector('[data-action="toggle-equip"]')?.addEventListener('click', () => {
      if (!canEquip) return
      if (isBodyShape) void this.switchBodyShape(item)
      else if (equipped) void this.unequipWearable(item)
      else void this.equipWearable(item)
    })

    this.appendColorPicker(detailEl.querySelector('.backpack-view__detail-card'), item, profile)
    this.hydrateCreatorFace(detailEl)
  }

  /**
   * Adds a COLOR button above the detail thumbnail for tintable categories. Clicking it
   * opens a popover (overlaying the name/actions) with presets + HSV sliders and an Apply
   * button that closes it. Color changes preview live; Apply just dismisses the window.
   */
  private appendColorPicker(
    card: Element | null,
    item: BackpackWearableItem,
    profile: AvatarProfile | null
  ): void {
    if (!card || !profile) return
    const channel = tintChannelForCategory(item.category)
    if (!channel) return
    const value = this.avatarColorValue(profile, channel)

    const trigger = document.createElement('button')
    trigger.type = 'button'
    trigger.className = 'backpack-view__color-trigger'
    const caption = document.createElement('span')
    caption.textContent = 'COLOR'
    const swatch = document.createElement('span')
    swatch.className = 'backpack-view__color-trigger-swatch'
    swatch.style.background = `#${value.replace('#', '')}`
    trigger.append(caption, swatch)
    card.prepend(trigger)

    // Eyes are a transparent grayscale sheet, so the thumbnail can be tinted to match the
    // avatar. Hair/skin thumbnails are full renders, not tint masks — leave those untouched.
    const thumbImg = channel === 'eyes' ? (card.querySelector('img') as HTMLImageElement | null) : null
    const tintThumb = thumbImg ? makeThumbnailTinter(thumbImg.src) : null
    const applyThumbTint = (hex: string): void => {
      if (!tintThumb || !thumbImg) return
      void tintThumb(hex).then((url) => {
        if (url) thumbImg.src = url
      })
    }
    applyThumbTint(value)

    const popover = document.createElement('div')
    popover.className = 'backpack-view__color-popover'
    popover.hidden = true

    const picker = createColorPicker({
      channel,
      value,
      onCommit: (hex) => {
        swatch.style.background = `#${hex}`
        applyThumbTint(hex)
        void this.setAvatarColor(channel, hex)
      }
    })
    picker.classList.add('backpack-color--popover')

    const apply = document.createElement('button')
    apply.type = 'button'
    apply.className = 'backpack-view__color-apply'
    apply.textContent = 'Apply Color'
    apply.addEventListener('click', () => {
      popover.hidden = true
      trigger.classList.remove('is-open')
    })

    popover.append(picker, apply)
    card.appendChild(popover)

    trigger.addEventListener('click', () => {
      popover.hidden = !popover.hidden
      trigger.classList.toggle('is-open', !popover.hidden)
    })
  }

  private avatarColorValue(profile: AvatarProfile, channel: ColorChannel): string {
    switch (channel) {
      case 'eyes':
        return profile.eyes
      case 'hair':
        return profile.hair
      case 'brows':
        return profile.browsColor ?? profile.hair
      case 'facial_hair':
        return profile.facialHairColor ?? profile.hair
      default:
        return profile.skin
    }
  }

  private async setAvatarColor(channel: ColorChannel, hex: string): Promise<void> {
    const profile = this.session.getProfile()
    if (!profile) return

    // Brows / facial hair are D3JS-exclusive: persisted to localStorage (not Catalyst)
    // and applied in-world immediately — the comms announce carries them as extension keys.
    if (channel === 'brows' || channel === 'facial_hair') {
      const address = this.session.getAddress() ?? profile.address
      if (!address) return
      setExtendedAvatarColor(address, channel === 'brows' ? 'brows' : 'facialHair', hex)
      this.session.setProfile(
        channel === 'brows'
          ? { ...profile, browsColor: hex }
          : { ...profile, facialHairColor: hex }
      )
      void this.loadAvatarModel()
      void this.onVrmEquipChange?.()
      return
    }

    const next: AvatarProfile =
      channel === 'eyes'
        ? { ...profile, eyes: hex }
        : channel === 'hair'
          ? { ...profile, hair: hex }
          : { ...profile, skin: hex }
    this.session.setProfile(next)
    // Rebuild the preview only — re-rendering the detail would rebuild the picker mid-drag.
    void this.loadAvatarModel()
  }

  private wearablesKeyFromProfile(): string {
    const profile = this.session.getProfile()
    if (!profile) return ''
    // Shared with SettingsOverlay so colour / bodyShape / emote edits deploy.
    return profileDeployFingerprint(profile)
  }

  /** True when profile fields that deploy to Catalyst changed since open or last save. */
  hasPendingProfileChanges(): boolean {
    if (this.session.getProfile()?.fromWallet !== true) return false
    const current = this.wearablesKeyFromProfile()
    return Boolean(current) && current !== this.baselineWearablesKey
  }

  /** Called after SettingsOverlay successfully deploys the profile. */
  markProfileBaselineSynced(): void {
    this.baselineWearablesKey = this.wearablesKeyFromProfile()
  }

  /**
   * After a successful Catalyst deploy — only refresh equipped state + avatar preview.
   * Inventory list is unchanged; no full re-fetch.
   */
  refreshAfterProfileSave(): void {
    this.baselineWearablesKey = this.wearablesKeyFromProfile()
    void this.loadEquippedWearables()
    void this.loadEmotes()
    if (this.activeSubTab === 'wearables') {
      this.renderGrid()
      const selected = this.selectedItem
        ? this.wearableItems.find((i) => this.isSameWearableUrn(i.urn, this.selectedItem))
        : null
      if (selected) {
        this.renderWearableDetail(selected)
        this.renderMobileInventoryDetail(selected)
      }
    } else if (this.activeSubTab === 'emotes') {
      this.renderEmotesUi()
    }
    if (this.mobileDrawer === 'equipped') this.renderMobileEquippedList()
    void this.loadAvatarModel()
  }

  private async equipWearable(item: BackpackWearableItem): Promise<void> {
    const profile = this.session.getProfile()
    if (!profile || item.category === 'unknown') return

    const wearables = equipWearableOnProfile(profile, item, this.equippedByCategory)
    this.session.setProfile({ ...profile, wearables })
    await this.applyWearableProfileChange(item)
  }

  private async unequipWearable(item: BackpackWearableItem): Promise<void> {
    const profile = this.session.getProfile()
    if (!profile) return

    const wearables = unequipWearableFromProfile(profile, item.urn)
    this.session.setProfile({ ...profile, wearables })
    await this.applyWearableProfileChange(item)
  }

  /**
   * Switch the avatar's body shape. Unlike equip, this sets profile.bodyShape and lets
   * buildComposeConfig re-derive the base body + shape-specific defaults on rebuild. Any
   * stale BaseMale/BaseFemale URN is dropped so the new shape's body is prepended cleanly.
   */
  private async switchBodyShape(item: BackpackWearableItem): Promise<void> {
    const profile = this.session.getProfile()
    if (!profile) return

    const target = bodyShapeFromUrn(item.urn)
    if (profile.bodyShape === target) return

    const wearables = profile.wearables.filter((u) => {
      const lower = u.toLowerCase()
      return !lower.includes('basemale') && !lower.includes('basefemale')
    })
    this.session.setProfile({ ...profile, bodyShape: target, wearables })
    await this.applyWearableProfileChange(item)
  }

  private async applyWearableProfileChange(item: BackpackWearableItem): Promise<void> {
    await this.loadEquippedWearables()
    this.renderGrid()
    this.renderWearableDetail(item)
    this.renderMobileInventoryDetail(item)
    if (this.mobileDrawer === 'equipped') this.renderMobileEquippedList()
    // Preview + in-world avatar from session profile (Catalyst deploy still on panel close).
    void this.loadAvatarModel()
    void this.onVrmEquipChange?.()
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

    stage.style.cursor = 'grab'
    stage.style.touchAction = 'none'
    stage.addEventListener('pointerdown', this.onPreviewPointerDown)
    stage.addEventListener('pointermove', this.onPreviewPointerMove)
    stage.addEventListener('pointerup', this.onPreviewPointerUp)
    stage.addEventListener('pointercancel', this.onPreviewPointerUp)
    stage.addEventListener(
      'wheel',
      (e) => {
        if (this.disposed) return
        e.preventDefault()
        this.previewZoom = THREE.MathUtils.clamp(
          this.previewZoom * (e.deltaY < 0 ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP),
          PREVIEW_ZOOM_MIN,
          PREVIEW_ZOOM_MAX
        )
        this.frameCamera(this.subjectSize)
      },
      { passive: false }
    )

    this.lastFrame = performance.now()
    this.raf = requestAnimationFrame((t) => this.tick(t))

    void this.loadAvatarModel()
  }

  private readonly onPreviewPointerDown = (e: PointerEvent): void => {
    if (this.disposed || e.button !== 0) return
    const stage = e.currentTarget as HTMLElement
    this.dragPointerId = e.pointerId
    this.dragLastX = e.clientX
    stage.setPointerCapture(e.pointerId)
    stage.style.cursor = 'grabbing'
  }

  private readonly onPreviewPointerMove = (e: PointerEvent): void => {
    if (this.disposed || this.dragPointerId !== e.pointerId) return
    const dx = e.clientX - this.dragLastX
    this.dragLastX = e.clientX
    this.orbitYaw += dx * 0.01
    if (this.pivot) this.pivot.rotation.y = this.orbitYaw
  }

  private readonly onPreviewPointerUp = (e: PointerEvent): void => {
    if (this.dragPointerId !== e.pointerId) return
    this.dragPointerId = null
    const stage = e.currentTarget as HTMLElement
    try {
      stage.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    stage.style.cursor = 'grab'
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
    // Align with pivot rotation at 0 so XZ center matches the ground ring.
    this.pivot!.rotation.y = 0
    this.subjectSize = alignPreviewAvatarToGround(avatar, 'dcl')

    this.animations = new AvatarAnimations()
    try {
      await this.animations.bind(avatar)
    } catch {
      this.animations.dispose()
      this.animations = null
    }

    // Idle pose shifts bones — re-seat feet on the ring after bind.
    this.subjectSize = alignPreviewAvatarToGround(avatar, 'dcl')
    this.pivot!.rotation.y = this.orbitYaw
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
        this.pivot!.rotation.y = this.orbitYaw
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
        this.pivot!.rotation.y = this.orbitYaw
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

    if (this.pivot) this.pivot.rotation.y = this.orbitYaw

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
    const distance = Math.max(fitHeight, fitWidth, 1.5) / this.previewZoom
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
    const stage = this.root.querySelector('.backpack-view__avatar-stage') as HTMLElement | null
    if (stage) {
      stage.removeEventListener('pointerdown', this.onPreviewPointerDown)
      stage.removeEventListener('pointermove', this.onPreviewPointerMove)
      stage.removeEventListener('pointerup', this.onPreviewPointerUp)
      stage.removeEventListener('pointercancel', this.onPreviewPointerUp)
    }
    this.clearAvatar()
    if (this.renderer) {
      this.renderer.forceContextLoss()
      this.renderer.dispose()
    }
    this.previewCanvas?.remove()
    // Sub-header may live in the overlay top bar; the slot clear also covers this.
    this.subHeaderEl?.remove()
  }
}