import * as THREE from 'three'
import type { SessionIdentity } from '../../../network/SessionIdentity'
import { AvatarAnimations } from '../../../avatar/AvatarAnimations'
import { composeAvatarFromProfile } from '../../../avatar/AvatarComposer'
import { disposeWearableInstance } from '../../../avatar/loadWearable'
import type { WearableCategory } from '../../../avatar/types'

type CategoryDef = { id: WearableCategory | 'all'; label: string; icon: string }

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
  private selectedCategory: WearableCategory | 'all' = 'all'
  private currentPage = 1
  private selectedItem: string | null = null
  private wearableUrns: string[] = []

  private previewCanvas: HTMLCanvasElement | null = null
  private renderer: THREE.WebGLRenderer | null = null
  private scene: THREE.Scene | null = null
  private camera: THREE.PerspectiveCamera | null = null
  private pivot: THREE.Group | null = null
  private avatar: THREE.Group | null = null
  private animations: AvatarAnimations | null = null
  private raf = 0
  private lastFrame = 0
  private disposed = false
  private resizeObserver: ResizeObserver | null = null
  private subjectSize = new THREE.Vector3(1.8, 1.8, 0.8)

  constructor(session: SessionIdentity) {
    this.session = session
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
        </div>
        <div class="backpack-view__toolbar">
          <button class="backpack-view__filter-btn">⚙ FILTER &amp; SORT</button>
          <input class="backpack-view__search" type="text" placeholder="Search item" />
        </div>
      </div>
      <div class="backpack-view__columns">
        <div class="backpack-view__left">
          <div class="backpack-view__avatar-stage"></div>
        </div>
        <div class="backpack-view__middle">
          <div class="backpack-view__middle-tabs">
            <button class="backpack-view__mid-tab is-active" data-midtab="categories">☰ CATEGORIES</button>
            <button class="backpack-view__mid-tab" data-midtab="outfits">♡ SAVED OUTFITS</button>
            <a class="backpack-view__marketplace-link" href="https://market.decentraland.org" target="_blank" rel="noopener">🛒 MARKETPLACE</a>
          </div>
          <div class="backpack-view__middle-body">
            <aside class="backpack-view__categories"></aside>
            <div class="backpack-view__grid-area">
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

    this.buildCategories()
    this.loadWearables()
    this.initAvatarPreview()
    this.wireSubTabs()
  }

  updateSession(session: SessionIdentity): void {
    this.session = session
    this.loadWearables()
    this.updateCategoryEquipped()
    this.loadAvatarModel()
  }

  private wireSubTabs(): void {
    const subTabs = this.root.querySelectorAll('.backpack-view__sub-tab')
    subTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        subTabs.forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')
      })
    })

    const midTabs = this.root.querySelectorAll('.backpack-view__mid-tab')
    midTabs.forEach((btn) => {
      btn.addEventListener('click', () => {
        midTabs.forEach((b) => b.classList.remove('is-active'))
        btn.classList.add('is-active')
      })
    })
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

    // fill empty slots
    const emptySlots = ITEMS_PER_PAGE - pageItems.length
    for (let i = 0; i < emptySlots; i++) {
      const empty = document.createElement('div')
      empty.className = 'backpack-view__item backpack-view__item--empty'
      gridEl.appendChild(empty)
    }

    // pagination
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

    // Gold platform
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

    this.loadAvatarModel()
  }

  private async loadAvatarModel(): Promise<void> {
    const profile = this.session.getProfile()
    const address = this.session.getAddress()
    if (!profile || !address) return

    this.clearAvatar()

    const avatar = await composeAvatarFromProfile({ ...profile, address, fromWallet: true })
    if (this.disposed) {
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

  private tick(now: number): void {
    if (this.disposed) return
    const delta = Math.min(0.05, (now - this.lastFrame) / 1000)
    this.lastFrame = now

    if (this.pivot) this.pivot.rotation.y += delta * 0.35
    this.animations?.update(delta, {
      horizontalSpeed: 0,
      grounded: true,
      locomotionMode: 'walk',
      jumping: false,
      doubleJumping: false,
      falling: false
    })

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
    if (!this.avatar || !this.pivot) return
    this.disposeGraph(this.avatar)
    this.pivot.remove(this.avatar)
    this.avatar = null
  }

  private disposeGraph(root: THREE.Object3D): void {
    disposeWearableInstance(root)
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
