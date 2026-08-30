/**
 * Fullscreen 3D Worlds catalog at `/worlds` — not the 2D /map shell.
 */
import { LoadingScreen } from '../LoadingScreen'
import { MapWorldPopup } from '../settings/MapWorldPopup'
import {
  fetchWorldMapDetail,
  loadWorldMapCatalog,
  type WorldMapEntry
} from '../../../map/worldsCatalog'
import { WorldsForestView } from '../../../map/WorldsForestView'
import { FOREST_RUNE_WATCH_MS } from '../../../map/forestRuneSeal'
import { ForestWorldList } from './ForestWorldList'
import { ForestWorldPanel } from './ForestWorldPanel'
import { WorldsLiveDataPoller } from '../../../map/worldsLiveData'
import { FOREST_OCCUPANCY_POLL_MS } from '../../../map/mapConfig'
import type { WorldsLiveData } from '../../../map/types'

export type ForestPageViewOptions = {
  onLeave: () => void
  onJumpInWorld: (worldName: string) => void
  profileId?: string | null
}

export class ForestPageView {
  readonly root: HTMLElement
  private readonly viewport: HTMLDivElement
  private readonly leaveBtn: HTMLButtonElement
  private readonly forest: WorldsForestView
  private readonly worldList = new ForestWorldList()
  private readonly worldPanel = new ForestWorldPanel()
  private readonly popup: MapWorldPopup
  private readonly poller = new WorldsLiveDataPoller()
  private readonly onLeave: () => void
  private readonly onJumpInWorld: (worldName: string) => void

  private loading: LoadingScreen | null = null
  private unsubLive: (() => void) | null = null
  private resizeObserver: ResizeObserver | null = null
  private catalog: WorldMapEntry[] = []
  private live: WorldsLiveData = { totalUsers: 0, perWorld: [], lastUpdated: null }
  private catalogGen = 0
  private popupGen = 0
  private disposed = false
  private booted = false
  private occupancyTimer = 0
  private jumping = false

  constructor(opts: ForestPageViewOptions) {
    this.onLeave = opts.onLeave
    this.onJumpInWorld = opts.onJumpInWorld

    this.root = document.createElement('div')
    this.root.className = 'forest-page-view map-view'
    this.root.setAttribute('aria-label', 'Worlds forest')

    this.viewport = document.createElement('div')
    this.viewport.className = 'forest-page-view__viewport'

    this.leaveBtn = document.createElement('button')
    this.leaveBtn.type = 'button'
    this.leaveBtn.className = 'forest-page-view__leave'
    this.leaveBtn.textContent = 'Leave'
    this.leaveBtn.addEventListener('click', () => this.onLeave())

    this.forest = new WorldsForestView({
      onSelectWorld: (worldName) => {
        this.worldList.setSelected(worldName)
        this.forest.focusVein(worldName)
        void this.openWorldPopup(worldName)
      },
      onApproachWorld: (entry) => this.onApproachWorld(entry),
      profileId: opts.profileId
    })
    this.viewport.appendChild(this.forest.root)
    this.worldList.setOnPick((worldName) => {
      if (this.jumping) return
      if (!worldName) {
        this.forest.focusVein(null)
        return
      }
      this.forest.focusVein(worldName)
    })
    this.worldPanel.setOnJump((worldName) => void this.jumpWithSeal(worldName))

    this.root.append(this.viewport, this.leaveBtn, this.worldList.root, this.worldPanel.root)

    this.popup = new MapWorldPopup({
      mountEl: this.root,
      onClose: () => this.closeWorldPopup(),
      onJumpIn: (worldName) => {
        this.closeWorldPopup()
        void this.jumpWithSeal(worldName)
      }
    })
  }

  mount(container: HTMLElement): void {
    if (this.disposed) return
    document.body.classList.add('forest-route')
    container.innerHTML = ''
    container.appendChild(this.root)

    this.resizeObserver = new ResizeObserver(() => this.syncSize())
    this.resizeObserver.observe(this.viewport)
    window.addEventListener('keydown', this.onKeyDown)

    this.loading = new LoadingScreen('Loading forest…', {
      slides: [
        {
          tag: 'Worlds',
          title: 'Worlds Forest',
          subtitle: 'Walk the clearing. Step onto a pool. Jump In.',
          imageUrl: '/forest/splash.jpg'
        }
      ]
    })
    this.loading.mount()
    this.loading.startLoadingTimer()
    this.loading.setStatus('Growing the forest…')
    this.loading.setProgress(0.08)

    this.forest.setActive(true)
    this.syncSize()

    void this.boot()
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    document.body.classList.remove('forest-route')
    window.removeEventListener('keydown', this.onKeyDown)
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.unsubLive?.()
    this.unsubLive = null
    if (this.occupancyTimer) window.clearInterval(this.occupancyTimer)
    this.occupancyTimer = 0
    this.poller.stop()
    this.popup.dispose()
    this.worldPanel.dispose()
    this.worldList.dispose()
    this.forest.dispose()
    this.loading?.dispose()
    this.loading = null
    this.root.remove()
  }

  private async boot(): Promise<void> {
    const loading = this.loading
    try {
      loading?.setStatus('Finding worlds…')
      loading?.setProgress(0.22)
      const avatarWait = this.forest.loadPlayerAvatar()

      this.unsubLive = this.poller.subscribe((state) => {
        this.live = state.data
        if (this.booted) void this.refreshCatalog()
      })
      await this.poller.refresh()
      if (this.disposed) return

      loading?.setStatus('Placing pools…')
      loading?.setProgress(0.55)
      await this.refreshCatalog()
      if (this.disposed) return

      this.poller.start()
      this.booted = true
      this.occupancyTimer = window.setInterval(() => void this.tickOccupancy(), FOREST_OCCUPANCY_POLL_MS)

      loading?.setStatus('Summoning your avatar…')
      loading?.setProgress(0.78)
      await Promise.race([
        avatarWait,
        new Promise<void>((resolve) => window.setTimeout(resolve, 6000))
      ])
      if (this.disposed) return

      loading?.setStatus('Stepping into the trees…')
      loading?.setProgress(0.9)
      await this.forest.waitForFirstFrame()
      if (this.disposed) return

      loading?.setStatus('Inscribing the seal…')
      loading?.setProgress(0.94)
      await this.forest.prewarmRuneSeal()
      if (this.disposed) return

      await loading?.finish(Promise.resolve())
      if (this.disposed) return
      this.loading = null
      this.forest.root.querySelector('canvas')?.focus({ preventScroll: true })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      loading?.showFatalError('Could not load the forest', message)
    }
  }

  private async tickOccupancy(): Promise<void> {
    if (this.disposed || !this.booted) return
    await this.poller.refresh()
    if (this.disposed) return
    await this.refreshCatalog()
  }

  private async refreshCatalog(): Promise<void> {
    const gen = ++this.catalogGen
    const catalog = await loadWorldMapCatalog(this.live, 64)
    if (this.disposed || gen !== this.catalogGen) return
    const prev = new Map(this.catalog.map((e) => [e.worldName.toLowerCase(), e] as const))
    for (const e of catalog) {
      const old = prev.get(e.worldName.toLowerCase())
      if (!old) continue
      if (!e.description && old.description) e.description = old.description
      if (!e.creatorAddress && old.creatorAddress) e.creatorAddress = old.creatorAddress
      if (!e.ownerName && old.ownerName) e.ownerName = old.ownerName
      if (!e.imageUrl && old.imageUrl) e.imageUrl = old.imageUrl
      if (!e.title && old.title) e.title = old.title
    }
    this.catalog = catalog
    this.forest.setWorlds(catalog)
    this.worldList.setWorlds(catalog)
    const open = this.worldPanel.getWorldName()
    if (open) {
      const live = catalog.find((w) => w.worldName.toLowerCase() === open.toLowerCase())
      if (live) this.worldPanel.refresh(live)
    }
    const sel = this.worldList.getSelected()
    if (sel && !this.worldPanel.isOpen()) this.forest.focusVein(sel)
  }

  private async openWorldPopup(worldName: string): Promise<void> {
    if (!worldName.trim() || this.disposed) return
    const gen = ++this.popupGen
    const key = worldName.toLowerCase()
    const cached = this.catalog.find((w) => w.worldName.toLowerCase() === key)
    if (cached) this.popup.showWorld(cached)
    else {
      this.popup.showWorld({
        worldName,
        users: 0,
        imageUrl: null,
        title: null
      })
    }
    if (cached?.description) return
    try {
      const detail = await fetchWorldMapDetail(worldName)
      if (gen !== this.popupGen || this.disposed || !detail) return
      const users = cached?.users ?? detail.users
      this.popup.showWorld({ ...detail, users })
    } catch {
      /* keep catalog snapshot */
    }
  }

  private closeWorldPopup(): void {
    this.popupGen += 1
    this.popup.hide()
  }

  private async jumpWithSeal(worldName: string): Promise<void> {
    const name = worldName.trim()
    if (!name || this.disposed || this.jumping) return
    this.jumping = true
    this.root.classList.add('is-jumping')
    this.closeWorldPopup()
    this.worldPanel.hide()
    this.worldList.setCollapsed(true)
    this.worldList.setSelected(null)
    try {
      await Promise.all([
        this.forest.playJumpSeal(),
        new Promise<void>((resolve) => window.setTimeout(resolve, FOREST_RUNE_WATCH_MS))
      ])
    } catch (err) {
      console.warn('[forest] rune seal failed', err)
    }
    if (this.disposed) return
    this.onJumpInWorld(name)
  }

  private onApproachWorld(entry: WorldMapEntry | null): void {
    if (this.jumping) return
    if (!entry) {
      this.worldPanel.hide()
      this.worldList.setCollapsed(false)
      const sel = this.worldList.getSelected()
      this.forest.focusVein(sel)
      return
    }
    this.closeWorldPopup()
    this.worldList.setCollapsed(true)
    this.forest.focusVein(entry.worldName)
    this.worldPanel.show(entry)
    void this.enrichWorldPanel(entry.worldName)
  }

  private async enrichWorldPanel(worldName: string): Promise<void> {
    const key = worldName.toLowerCase()
    const cached = this.catalog.find((w) => w.worldName.toLowerCase() === key)
    if (
      cached?.imageUrl &&
      cached.description &&
      (cached.creatorAddress || cached.ownerName)
    ) {
      this.worldPanel.refresh(cached)
      return
    }
    try {
      const detail = await fetchWorldMapDetail(worldName)
      if (this.disposed || this.worldPanel.getWorldName()?.toLowerCase() !== key) return
      if (!detail) {
        if (cached) this.worldPanel.refresh(cached)
        return
      }
      const merged: WorldMapEntry = {
        ...cached,
        ...detail,
        worldName: cached?.worldName ?? detail.worldName,
        users: cached?.users ?? detail.users,
        imageUrl: cached?.imageUrl || detail.imageUrl,
        connectedAddresses: cached?.connectedAddresses ?? detail.connectedAddresses
      }
      const idx = this.catalog.findIndex((w) => w.worldName.toLowerCase() === key)
      if (idx >= 0) {
        this.catalog[idx] = {
          ...this.catalog[idx]!,
          description: merged.description ?? this.catalog[idx]!.description,
          creatorAddress: merged.creatorAddress ?? this.catalog[idx]!.creatorAddress,
          ownerName: merged.ownerName ?? this.catalog[idx]!.ownerName,
          imageUrl: merged.imageUrl ?? this.catalog[idx]!.imageUrl,
          title: merged.title ?? this.catalog[idx]!.title
        }
        this.worldList.setWorlds(this.catalog)
      }
      this.worldPanel.refresh(merged)
    } catch {
      /* keep catalog snapshot */
    }
  }

  private syncSize(): void {
    const w = this.viewport.clientWidth || window.innerWidth || 960
    const h = this.viewport.clientHeight || window.innerHeight || 640
    this.forest.resize(w, h)
  }

  private onKeyDown = (ev: KeyboardEvent): void => {
    if (this.disposed || this.jumping) return
    if (ev.code !== 'Escape') return
    if (this.popup.isVisible()) {
      this.closeWorldPopup()
      ev.preventDefault()
      return
    }
    if (this.worldList.getSelected()) {
      this.worldList.setSelected(null)
      this.forest.focusVein(null)
      ev.preventDefault()
    }
  }
}
