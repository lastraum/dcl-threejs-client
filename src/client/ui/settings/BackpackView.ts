import * as THREE from 'three'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { AvatarAnimations } from '../../../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../../../avatar/AvatarComposer'
import { disposeWearableInstance } from '../../../avatar/loadWearable'
import type { WearableCategory } from '../../../avatar/types'
import { VrmAvatar } from '../../../avatar/vrm/VrmAvatar'
import { disposeVrmRoot } from '../../../avatar/vrm/VrmLoader'
import {
  addVrmFile,
  formatVrmByteSize,
  listVrmLibrary,
  loadVrmLibraryBytes,
  removeVrmFromLibrary,
  type VrmLibraryEntry
} from '../../../avatar/vrm/VrmLibrary'
import { getActiveProfileAddress } from '../../../avatar/LocalAvatar'
import { getEquippedVrmHash, setEquippedVrmHash } from '../../../avatar/vrm/vrmEquipStorage'

type CategoryDef = { id: WearableCategory | 'all'; label: string; icon: string }
type BackpackSubTab = 'wearables' | 'emotes' | 'vrm'

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
  private animations: AvatarAnimations | null = null
  private raf = 0
  private lastFrame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  private subjectSize = new THREE.Vector3(1.8, 1.8, 0.8)
  private previewMode: 'dcl' | 'vrm' = 'dcl'
  private vrmFileInput: HTMLInputElement | null = null

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
            <span>🧬</span> Custom VRMs
          </button>
        </div>
        <div class="backpack-view__toolbar backpack-view__toolbar--wearables">
          <button class="backpack-view__filter-btn">⚙ FILTER &amp; SORT</button>
          <input class="backpack-view__search" type="text" placeholder="Search item" />
        </div>
        <input type="file" accept=".vrm,model/vrm" class="backpack-view__vrm-file-input" hidden />
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
            <span class="backpack-view__vrm-library-label">Your VRM library (stored on this device)</span>
          </div>
          <div class="backpack-view__middle-body">
            <aside class="backpack-view__categories"></aside>
            <div class="backpack-view__grid-area">
              <div class="backpack-view__vrm-drop-hint" hidden>
                <span class="backpack-view__vrm-drop-hint-icon" aria-hidden="true">🧬</span>
                <p class="backpack-view__vrm-drop-hint-title">Drop your .vrm here</p>
                <p class="backpack-view__vrm-drop-hint-sub">or click to browse · stored on this device only</p>
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
    void this.refreshVrmLibrary()
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
      if (file) void this.handleVrmUpload(file)
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
      const file = this.pickVrmFile(e.dataTransfer)
      if (file) void this.handleVrmUpload(file)
    })
  }

  private pickVrmFile(dataTransfer: DataTransfer | null): File | null {
    if (!dataTransfer?.files?.length) return null
    for (const file of dataTransfer.files) {
      if (file.name.toLowerCase().endsWith('.vrm')) return file
    }
    return null
  }

  private applySubTabLayout(): void {
    const wearablesToolbar = this.root.querySelector('.backpack-view__toolbar--wearables') as HTMLElement
    const wearablesMidTabs = this.root.querySelector('.backpack-view__middle-tabs--wearables') as HTMLElement
    const vrmMidTabs = this.root.querySelector('.backpack-view__middle-tabs--vrm') as HTMLElement
    const dropHint = this.root.querySelector('.backpack-view__vrm-drop-hint') as HTMLElement
    const isVrm = this.activeSubTab === 'vrm'

    this.root.classList.toggle('backpack-view--vrm', isVrm)
    wearablesToolbar.hidden = isVrm
    wearablesMidTabs.hidden = isVrm
    vrmMidTabs.hidden = !isVrm
    dropHint.hidden = !isVrm

    if (isVrm) {
      this.renderVrmGrid()
      void this.loadVrmPreview(this.selectedVrmHash)
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
    const equipped = getEquippedVrmHash(this.resolveEquipAddress())
    if (equipped && !this.selectedVrmHash) {
      this.selectedVrmHash = equipped
    }
    if (this.activeSubTab === 'vrm') {
      this.renderVrmGrid()
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

  private renderVrmGrid(): void {
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
      const isEquipped = entry.contentHash === getEquippedVrmHash(this.resolveEquipAddress())
      card.className =
        'backpack-view__vrm-card' +
        (isSelected ? ' is-selected' : '') +
        (isEquipped ? ' is-equipped' : '')
      card.innerHTML = `
        <div class="backpack-view__vrm-card-icon">🧬</div>
        <span class="backpack-view__vrm-card-name">${this.escapeHtml(entry.fileName)}</span>
        <span class="backpack-view__vrm-card-size">${formatVrmByteSize(entry.byteSize)}</span>
        ${isEquipped ? '<span class="backpack-view__vrm-equipped-badge">Equipped</span>' : ''}
      `
      card.addEventListener('click', () => {
        this.selectedVrmHash = entry.contentHash
        this.renderVrmGrid()
        void this.loadVrmPreview(entry.contentHash)
      })
      gridEl.appendChild(card)
    }
  }

  private renderVrmDetail(entry: VrmLibraryEntry | null): void {
    const detailEl = this.root.querySelector('.backpack-view__detail')!
    if (!entry) {
      detailEl.innerHTML = `<p class="backpack-view__detail-empty">Select or upload a VRM</p>`
      return
    }

    const address = this.session.getAddress()
    const equippedHash = getEquippedVrmHash(address)
    const isEquipped = equippedHash === entry.contentHash

    detailEl.innerHTML = `
      <div class="backpack-view__detail-card backpack-view__detail-card--vrm">
        <div class="backpack-view__vrm-detail-icon">🧬</div>
        <h3 class="backpack-view__detail-name">${this.escapeHtml(entry.fileName)}</h3>
        <p class="backpack-view__vrm-detail-meta">${formatVrmByteSize(entry.byteSize)} · ${new Date(entry.addedAt).toLocaleDateString()}</p>
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

  private async handleVrmUpload(file: File): Promise<void> {
    if (this.vrmUploadBusy) return
    this.vrmUploadBusy = true
    const gridArea = this.root.querySelector('.backpack-view__grid-area') as HTMLElement
    gridArea?.classList.add('is-uploading')

    try {
      const entry = await addVrmFile(file)
      await this.refreshVrmLibrary()
      this.selectedVrmHash = entry.contentHash
      this.activeSubTab = 'vrm'
      this.root.querySelectorAll('.backpack-view__sub-tab').forEach((btn) => {
        btn.classList.toggle('is-active', (btn as HTMLElement).dataset.subtab === 'vrm')
      })
      this.applySubTabLayout()
      void this.loadVrmPreview(entry.contentHash)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      alert(`VRM upload failed: ${msg}`)
    } finally {
      this.vrmUploadBusy = false
      gridArea?.classList.remove('is-uploading')
    }
  }

  private resolveEquipAddress(): string | undefined {
    return this.session.getAddress() ?? getActiveProfileAddress()
  }

  private async equipVrm(contentHash: string): Promise<void> {
    const address = this.resolveEquipAddress()
    if (!address) {
      alert('Set a profile wallet (?profile=0x…) or connect a wallet to equip a custom VRM.')
      return
    }
    setEquippedVrmHash(address, contentHash)
    this.selectedVrmHash = contentHash
    this.renderVrmGrid()
    this.renderVrmDetail(this.vrmLibrary.find((e) => e.contentHash === contentHash) ?? null)
    await this.onVrmEquipChange?.()
    void this.loadVrmPreview(contentHash)
  }

  private async unequipVrm(): Promise<void> {
    const address = this.resolveEquipAddress()
    if (!address) return
    setEquippedVrmHash(address, null)
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
    if (address && getEquippedVrmHash(address) === contentHash) {
      await this.unequipVrm()
    }
    await removeVrmFromLibrary(contentHash)
    if (this.selectedVrmHash === contentHash) {
      this.selectedVrmHash = null
    }
    await this.refreshVrmLibrary()
    this.renderVrmGrid()
    if (this.selectedVrmHash) {
      void this.loadVrmPreview(this.selectedVrmHash)
    } else {
      void this.loadVrmPreview(null)
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

    const box = new THREE.Box3().setFromObject(avatar)
    const center = box.getCenter(new THREE.Vector3())
    avatar.position.set(-center.x, -box.min.y, -center.z)
    this.avatar = avatar
    this.pivot!.add(avatar)

    this.animations = new AvatarAnimations()
    try {
      await this.animations.bind(avatar)
    } catch {
      this.animations.dispose()
      this.animations = null
    }

    this.subjectSize = box.getSize(new THREE.Vector3())
    this.subjectSize.y += 0.18
    this.subjectSize.x = Math.max(this.subjectSize.x, 0.9)
    this.frameCamera(this.subjectSize)
  }

  private async loadVrmPreview(contentHash: string | null): Promise<void> {
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

    this.previewMode = 'vrm'
    this.clearAvatar()

    try {
      const vrm = await VrmAvatar.fromBytes(bytes)
      if (this.disposed || this.previewMode !== 'vrm') {
        vrm.dispose()
        return
      }

      const box = new THREE.Box3().setFromObject(vrm.root)
      const center = box.getCenter(new THREE.Vector3())
      vrm.root.position.set(-center.x, -box.min.y, -center.z)
      this.vrmPreview = vrm
      this.avatar = vrm.root
      this.pivot!.add(vrm.root)

      this.subjectSize = box.getSize(new THREE.Vector3())
      this.subjectSize.y += 0.18
      this.subjectSize.x = Math.max(this.subjectSize.x, 0.9)
      this.frameCamera(this.subjectSize)
    } catch (err) {
      console.warn('[backpack] VRM preview failed', err)
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
    this.animations?.dispose()
    this.animations = null
    if (this.vrmPreview) {
      this.pivot?.remove(this.vrmPreview.root)
      this.vrmPreview.dispose()
      this.vrmPreview = null
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