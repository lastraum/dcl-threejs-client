import { ArchipelagoPeersPoller } from '../../../map/archipelagoPeers'
import { fetchCatalystProfiles, getCachedProfile } from '../../../map/catalystProfiles'
import {
  VIEWPORT_DEFAULT_CENTER_TILE,
  VIEWPORT_DEFAULT_ZOOM,
  VIEWPORT_FETCH_ZOOM,
  VIEWPORT_MAX_ZOOM,
  VIEWPORT_MIN_ZOOM,
  centerViewOnParcel,
  mapTileUrl,
  parcelScreenRect,
  playerMarkerRect,
  screenPointToParcel,
  visibleTiles,
  type MapViewState
} from '../../../map/genesisMapViewport'
import { fetchParcelInfo } from '../../../map/parcelInfo'
import {
  normalizeWallet,
  parcelIndicesFromPeer,
  parcelKeyFromPeer
} from '../../../map/peerParcel'
import type {
  ArchipelagoConnectionState,
  LivePeer,
  PlayerProfile,
  WorldsConnectionState,
  WorldsLiveData
} from '../../../map/types'
import { WorldsLiveDataPoller } from '../../../map/worldsLiveData'
import { MapParcelPopup } from './MapParcelPopup'

export type MapPlayerState = {
  position: { x: number; y: number; z: number }
  parcelKey: string
  address?: string
  displayName?: string
  faceUrl?: string | null
}

export type MapViewOptions = {
  getPlayerState: () => MapPlayerState | null
  onJumpIn?: (px: number, py: number) => void
}

const INITIAL_VIEW: MapViewState = {
  zoom: VIEWPORT_DEFAULT_ZOOM,
  centerTileX: VIEWPORT_DEFAULT_CENTER_TILE.x,
  centerTileY: VIEWPORT_DEFAULT_CENTER_TILE.y,
  panX: 0,
  panY: 0
}

const DRAG_THRESHOLD_PX = 6

function playerSortKey(displayName: string, address: string): string {
  const name = displayName.trim()
  if (!name || name === '?') return address
  return name
}

function connectionLabel(state: string): string {
  switch (state) {
    case 'live':
      return 'Live'
    case 'loading':
      return 'Loading…'
    case 'error':
      return 'Offline'
    default:
      return '…'
  }
}

function formatUpdatedAgo(updatedAtMs: number | null, now = Date.now()): string {
  if (!updatedAtMs) return '—'
  const sec = Math.max(0, Math.floor((now - updatedAtMs) / 1000))
  if (sec < 5) return 'just now'
  if (sec < 60) return `${sec}s ago`
  return `${Math.floor(sec / 60)}m ago`
}

/** Full Genesis City map — neurolink decentraland directory parity. */
export class MapView {
  readonly root: HTMLElement
  private readonly viewport: HTMLDivElement
  private readonly tilesLayer: HTMLDivElement
  private readonly highlightsLayer: HTMLDivElement
  private readonly markersLayer: HTMLDivElement
  private readonly playerList: HTMLOListElement
  private readonly worldList: HTMLOListElement
  private readonly playerSearchInput: HTMLInputElement
  private readonly genesisMeta: HTMLParagraphElement
  private readonly worldsMeta: HTMLParagraphElement
  private readonly statusEl: HTMLSpanElement
  private readonly countEl: HTMLSpanElement
  private readonly genesisEmpty: HTMLParagraphElement
  private readonly worldsEmpty: HTMLParagraphElement
  private readonly peersError: HTMLParagraphElement
  private readonly worldsError: HTMLParagraphElement
  private readonly getPlayerState: () => MapPlayerState | null
  private readonly onJumpIn?: (px: number, py: number) => void

  private view: MapViewState = { ...INITIAL_VIEW }
  private viewSize = { w: 0, h: 0 }
  private disposed = false
  private active = false
  private rafId = 0
  private nowTimer = 0
  private nowMs = Date.now()
  private resizeObserver: ResizeObserver | null = null
  private tileNodes = new Map<string, HTMLImageElement>()
  private markerNodes = new Map<string, HTMLButtonElement>()
  private profileCache = new Map<string, PlayerProfile>()
  private profileFetchGen = 0
  private dragRef: {
    pointerId: number
    startX: number
    startY: number
    panX: number
    panY: number
    moved: boolean
  } | null = null

  private peersPoller = new ArchipelagoPeersPoller()
  private worldsPoller = new WorldsLiveDataPoller()
  private unsubscribePeers: (() => void) | null = null
  private unsubscribeWorlds: (() => void) | null = null

  private connection: ArchipelagoConnectionState = 'idle'
  private peersErrorMsg: string | null = null
  private players: LivePeer[] = []
  private peersUpdatedAtMs: number | null = null

  private worldsConnection: WorldsConnectionState = 'idle'
  private worldsErrorMsg: string | null = null
  private worldsData: WorldsLiveData = { totalUsers: 0, perWorld: [], lastUpdated: null }
  private worldsUpdatedAtMs: number | null = null

  private playerSearch = ''
  private highlightedPlayer: string | null = null
  private highlightParcel: { px: number; py: number } | null = null
  private parcelFetchGen = 0
  private parcelPopup: MapParcelPopup | null = null

  constructor({ getPlayerState, onJumpIn }: MapViewOptions) {
    this.getPlayerState = getPlayerState
    this.onJumpIn = onJumpIn

    this.root = document.createElement('div')
    this.root.className = 'map-view dcl-map-page'

    this.root.innerHTML = `
      <div class="dcl-map__viewport" tabindex="0" aria-label="Genesis City map">
        <div class="dcl-map__tiles" aria-hidden="true"></div>
        <div class="dcl-map__highlights" aria-hidden="true"></div>
        <div class="dcl-map__markers" aria-hidden="true"></div>
      </div>

      <header class="dcl-map__hud dcl-map__hud--top">
        <div class="dcl-map__hud-copy">
          <p class="dcl-map__eyebrow">Decentraland · EA realm</p>
          <h1 class="dcl-map__title">Genesis City Live</h1>
        </div>
        <div class="dcl-map__hud-controls">
          <span class="dcl-map__status" role="status"></span>
          <span class="dcl-map__count"></span>
          <button type="button" class="dcl-map__btn" data-center-plaza>Genesis Plaza</button>
          <button type="button" class="dcl-map__btn" data-center-player>My location</button>
          <button type="button" class="dcl-map__btn" data-retry-peers hidden>Retry</button>
        </div>
      </header>

      <aside class="dcl-map__sidebar" aria-label="Live activity">
        <section class="dcl-map__sidebar-section dcl-map__sidebar-section--genesis" aria-label="Genesis City players">
          <div class="dcl-map__sidebar-head">
            <h2 class="dcl-map__sidebar-title">Genesis City</h2>
            <p class="dcl-map__sidebar-meta" data-genesis-meta></p>
            <label class="dcl-map__search">
              <span class="dcl-map__search-label">Search players and worlds</span>
              <input type="search" class="dcl-map__search-input" placeholder="Name, wallet, parcel, or world…" autocomplete="off" spellcheck="false" />
            </label>
          </div>
          <div class="dcl-map__sidebar-body">
            <p class="dcl-map__sidebar-empty" data-genesis-empty hidden></p>
            <ol class="dcl-map__player-list"></ol>
          </div>
        </section>

        <section class="dcl-map__sidebar-section dcl-map__sidebar-section--worlds" aria-label="Worlds activity">
          <div class="dcl-map__sidebar-head dcl-map__sidebar-head--compact">
            <h2 class="dcl-map__sidebar-title">Worlds</h2>
            <p class="dcl-map__sidebar-meta" data-worlds-meta></p>
          </div>
          <div class="dcl-map__sidebar-body">
            <p class="dcl-map__sidebar-empty" data-worlds-empty hidden></p>
            <ol class="dcl-map__world-list"></ol>
          </div>
        </section>

        <footer class="dcl-map__sidebar-foot">
          <span>Drag to pan · click parcel · scroll to zoom</span>
        </footer>
      </aside>

      <p class="dcl-map__error" role="alert" data-peers-error hidden></p>
      <p class="dcl-map__error dcl-map__error--worlds" role="alert" data-worlds-error hidden></p>
    `

    this.viewport = this.root.querySelector('.dcl-map__viewport')!
    this.tilesLayer = this.root.querySelector('.dcl-map__tiles')!
    this.highlightsLayer = this.root.querySelector('.dcl-map__highlights')!
    this.markersLayer = this.root.querySelector('.dcl-map__markers')!
    this.playerList = this.root.querySelector('.dcl-map__player-list')!
    this.worldList = this.root.querySelector('.dcl-map__world-list')!
    this.playerSearchInput = this.root.querySelector('.dcl-map__search-input')!
    this.genesisMeta = this.root.querySelector('[data-genesis-meta]')!
    this.worldsMeta = this.root.querySelector('[data-worlds-meta]')!
    this.statusEl = this.root.querySelector('.dcl-map__status')!
    this.countEl = this.root.querySelector('.dcl-map__count')!
    this.genesisEmpty = this.root.querySelector('[data-genesis-empty]')!
    this.worldsEmpty = this.root.querySelector('[data-worlds-empty]')!
    this.peersError = this.root.querySelector('[data-peers-error]')!
    this.worldsError = this.root.querySelector('[data-worlds-error]')!

    this.root.querySelector('[data-center-plaza]')!.addEventListener('click', () => this.centerOnParcel(0, 0))
    this.root.querySelector('[data-center-player]')!.addEventListener('click', () => this.centerOnPlayer())
    this.root.querySelector('[data-retry-peers]')!.addEventListener('click', () => void this.peersPoller.refresh())
    this.playerSearchInput.addEventListener('input', () => {
      this.playerSearch = this.playerSearchInput.value
      this.renderSidebar()
    })

    this.viewport.addEventListener('pointerdown', this.onPointerDown)
    this.viewport.addEventListener('wheel', this.onWheel, { passive: false })

    this.parcelPopup = new MapParcelPopup({
      mountEl: this.root,
      onClose: () => this.closeParcelPopup(),
      onJumpIn: (px, py) => {
        this.closeParcelPopup()
        this.onJumpIn?.(px, py)
      }
    })
  }

  mount(): void {
    if (this.disposed) return
    this.active = true
    this.resizeObserver = new ResizeObserver(() => this.measureViewport())
    this.resizeObserver.observe(this.viewport)
    this.measureViewport()
    this.centerOnPlayer()

    this.unsubscribePeers = this.peersPoller.subscribe((state) => {
      this.connection = state.connection
      this.peersErrorMsg = state.error
      this.players = state.players
      this.peersUpdatedAtMs = state.updatedAtMs
      void this.ensureProfiles(this.players.map((p) => p.address))
      this.renderHud()
      this.renderSidebar()
      this.renderFrame()
    })
    this.unsubscribeWorlds = this.worldsPoller.subscribe((state) => {
      this.worldsConnection = state.connection
      this.worldsErrorMsg = state.error
      this.worldsData = state.data
      this.worldsUpdatedAtMs = state.updatedAtMs
      this.renderHud()
      this.renderSidebar()
    })

    this.peersPoller.start()
    this.worldsPoller.start()
    this.nowTimer = window.setInterval(() => {
      this.nowMs = Date.now()
      this.renderHud()
      this.renderSidebar()
    }, 1000)
    this.startRenderLoop()
  }

  dispose(): void {
    this.disposed = true
    this.active = false
    this.stopRenderLoop()
    if (this.nowTimer) window.clearInterval(this.nowTimer)
    this.nowTimer = 0
    this.unsubscribePeers?.()
    this.unsubscribePeers = null
    this.unsubscribeWorlds?.()
    this.unsubscribeWorlds = null
    this.peersPoller.stop()
    this.worldsPoller.stop()
    this.resizeObserver?.disconnect()
    this.resizeObserver = null
    this.endDragSession()
    this.viewport.removeEventListener('pointerdown', this.onPointerDown)
    this.viewport.removeEventListener('wheel', this.onWheel)
    this.tileNodes.clear()
    this.markerNodes.clear()
    this.parcelPopup?.dispose()
    this.parcelPopup = null
    this.root.remove()
  }

  centerOnPlayer(): void {
    const player = this.getPlayerState()
    if (!player) return
    const m = /^(-?\d+),(-?\d+)$/.exec(player.parcelKey.trim())
    if (!m) return
    this.view = centerViewOnParcel(this.view, parseInt(m[1], 10), parseInt(m[2], 10))
    this.renderFrame()
  }

  private centerOnParcel(px: number, py: number): void {
    this.view = centerViewOnParcel(this.view, px, py)
    this.renderFrame()
  }

  private measureViewport(): void {
    const w = this.viewport.clientWidth
    const h = this.viewport.clientHeight
    if (w === this.viewSize.w && h === this.viewSize.h) return
    this.viewSize = { w: w || 960, h: h || 640 }
    this.renderFrame()
  }

  private startRenderLoop(): void {
    this.stopRenderLoop()
    const tick = () => {
      if (!this.active || this.disposed) return
      this.renderFrame()
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopRenderLoop(): void {
    if (this.rafId) cancelAnimationFrame(this.rafId)
    this.rafId = 0
  }

  private async ensureProfiles(wallets: string[]): Promise<void> {
    const unique = [...new Set(wallets.map(normalizeWallet).filter(Boolean))]
    const missing = unique.filter((w) => !this.profileCache.has(w))
    if (!missing.length) return

    const gen = ++this.profileFetchGen
    const fetched = await fetchCatalystProfiles(missing)
    if (gen !== this.profileFetchGen) return
    for (const [wallet, profile] of fetched) {
      this.profileCache.set(wallet, profile)
    }
    this.renderSidebar()
    this.renderFrame()
  }

  private getProfile(wallet: string): PlayerProfile {
    return getCachedProfile(this.profileCache, wallet)
  }

  private allPlayerRows(): LivePeer[] {
    const local = this.getPlayerState()
    const rows = [...this.players]
    if (local?.address) {
      const addr = normalizeWallet(local.address)
      if (!rows.some((p) => normalizeWallet(p.address) === addr)) {
        const m = /^(-?\d+),(-?\d+)$/.exec(local.parcelKey.trim())
        if (m) {
          rows.unshift({
            address: addr,
            parcel: [parseInt(m[1], 10), parseInt(m[2], 10)],
            position: local.position,
            lastPing: 0
          })
        }
      }
    }
    return rows.sort((a, b) => {
      const ka = playerSortKey(this.profileForPeer(a), a.address)
      const kb = playerSortKey(this.profileForPeer(b), b.address)
      const byName = ka.localeCompare(kb, undefined, { sensitivity: 'base' })
      return byName !== 0 ? byName : a.address.localeCompare(b.address)
    })
  }

  private profileForPeer(peer: LivePeer): string {
    const local = this.getPlayerState()
    if (local?.address && normalizeWallet(local.address) === normalizeWallet(peer.address)) {
      return local.displayName ?? this.getProfile(peer.address).displayName
    }
    return this.getProfile(peer.address).displayName
  }

  private faceUrlForPeer(peer: LivePeer): string | null {
    const local = this.getPlayerState()
    if (local?.address && normalizeWallet(local.address) === normalizeWallet(peer.address)) {
      return local.faceUrl ?? this.getProfile(peer.address).faceUrl
    }
    return this.getProfile(peer.address).faceUrl
  }

  private filteredPlayerRows(): LivePeer[] {
    const q = this.playerSearch.trim().toLowerCase()
    const rows = this.allPlayerRows()
    if (!q) return rows
    return rows.filter((peer) => {
      const profile = this.profileForPeer(peer)
      const parcelKey = parcelKeyFromPeer(peer)
      const haystack = `${profile} ${peer.address} ${parcelKey}`.toLowerCase()
      return haystack.includes(q)
    })
  }

  private filteredWorldRows() {
    const q = this.playerSearch.trim().toLowerCase()
    if (!q) return this.worldsData.perWorld
    return this.worldsData.perWorld.filter((world) => world.worldName.toLowerCase().includes(q))
  }

  private renderHud(): void {
    this.statusEl.textContent = connectionLabel(this.connection)
    this.statusEl.className = `dcl-map__status dcl-map__status--${this.connection}`
    this.countEl.textContent = `${this.players.length} in Genesis · ${this.worldsData.totalUsers} in Worlds`

    const retryBtn = this.root.querySelector<HTMLButtonElement>('[data-retry-peers]')
    if (retryBtn) retryBtn.hidden = this.connection !== 'error'

    if (this.peersErrorMsg && this.connection === 'error') {
      this.peersError.hidden = false
      this.peersError.textContent = `Genesis peers: ${this.peersErrorMsg}`
    } else {
      this.peersError.hidden = true
    }

    if (this.worldsErrorMsg && this.worldsConnection === 'error') {
      this.worldsError.hidden = false
      this.worldsError.innerHTML = `Worlds: ${escapeHtml(this.worldsErrorMsg)} <button type="button" class="dcl-map__btn">Retry</button>`
      this.worldsError.querySelector('.dcl-map__btn')?.addEventListener('click', () => void this.worldsPoller.refresh())
    } else {
      this.worldsError.hidden = true
    }
  }

  private renderSidebar(): void {
    const playerRows = this.allPlayerRows()
    const filteredPlayers = this.filteredPlayerRows()
    const filteredWorlds = this.filteredWorldRows()

    this.genesisMeta.textContent = `${playerRows.length} active · updated ${formatUpdatedAgo(this.peersUpdatedAtMs, this.nowMs)}`
    this.worldsMeta.textContent = `${this.worldsData.totalUsers} active · ${this.worldsData.perWorld.length} worlds · updated ${formatUpdatedAgo(this.worldsUpdatedAtMs, this.nowMs)}`

    if (playerRows.length === 0) {
      this.genesisEmpty.hidden = false
      this.genesisEmpty.textContent =
        this.connection === 'loading' ? 'Fetching peers…' : 'No players on catalyst right now.'
      this.playerList.innerHTML = ''
    } else if (filteredPlayers.length === 0) {
      this.genesisEmpty.hidden = false
      this.genesisEmpty.textContent = `No players match "${this.playerSearch.trim()}".`
      this.playerList.innerHTML = ''
    } else {
      this.genesisEmpty.hidden = true
      this.playerList.innerHTML = filteredPlayers
        .map((peer) => {
          const name = this.profileForPeer(peer)
          const parcelKey = parcelKeyFromPeer(peer)
          const canCenter = parcelIndicesFromPeer(peer) !== null
          const highlighted = this.highlightedPlayer === peer.address
          return `
            <li>
              <button type="button" class="dcl-map__player-row${highlighted ? ' dcl-map__player-row--highlighted' : ''}" data-address="${escapeAttr(peer.address)}" ${canCenter ? '' : 'disabled'} title="${escapeAttr(canCenter ? `Center map on ${name}` : `${name} — no position`)}">
                ${renderAvatar(name, this.faceUrlForPeer(peer), 32)}
                <span class="dcl-map__player-name">${escapeHtml(name)}</span>
                <code class="dcl-map__player-parcel">${escapeHtml(parcelKey)}</code>
              </button>
            </li>`
        })
        .join('')

      for (const btn of this.playerList.querySelectorAll<HTMLButtonElement>('.dcl-map__player-row')) {
        btn.addEventListener('click', () => {
          const address = btn.dataset.address
          if (!address) return
          this.highlightedPlayer = address
          this.playerSearchInput.value = ''
          this.playerSearch = ''
          const peer = filteredPlayers.find((p) => p.address === address)
          if (peer) this.centerOnPeer(peer)
          this.renderSidebar()
          this.renderFrame()
        })
      }
    }

    if (this.worldsConnection === 'loading' && this.worldsData.perWorld.length === 0) {
      this.worldsEmpty.hidden = false
      this.worldsEmpty.textContent = 'Fetching worlds…'
      this.worldList.innerHTML = ''
    } else if (this.worldsData.perWorld.length === 0) {
      this.worldsEmpty.hidden = false
      this.worldsEmpty.textContent = 'No active worlds right now.'
      this.worldList.innerHTML = ''
    } else if (filteredWorlds.length === 0) {
      this.worldsEmpty.hidden = false
      this.worldsEmpty.textContent = `No worlds match "${this.playerSearch.trim()}".`
      this.worldList.innerHTML = ''
    } else {
      this.worldsEmpty.hidden = true
      this.worldList.innerHTML = filteredWorlds
        .map(
          (world) => `
          <li>
            <div class="dcl-map__world-row">
              <span class="dcl-map__world-name">${escapeHtml(world.worldName)}</span>
              <span class="dcl-map__world-count">${world.users}</span>
            </div>
          </li>`
        )
        .join('')
    }
  }

  private centerOnPeer(peer: LivePeer): void {
    const indices = parcelIndicesFromPeer(peer)
    if (!indices) return
    this.view = centerViewOnParcel(this.view, indices.px, indices.py)
    this.renderFrame()
  }

  private renderFrame(): void {
    if (!this.active) return
    const { w, h } = this.viewSize
    if (w <= 0 || h <= 0) return

    const tiles = visibleTiles(w, h, this.view)
    const seen = new Set<string>()

    for (const tile of tiles) {
      const key = `${tile.tx},${tile.ty}`
      seen.add(key)
      let img = this.tileNodes.get(key)
      if (!img) {
        img = document.createElement('img')
        img.alt = ''
        img.draggable = false
        img.decoding = 'async'
        img.loading = 'lazy'
        img.src = mapTileUrl(VIEWPORT_FETCH_ZOOM, tile.tx, tile.ty)
        this.tilesLayer.appendChild(img)
        this.tileNodes.set(key, img)
      }
      img.style.left = `${tile.left}px`
      img.style.top = `${tile.top}px`
      img.style.width = `${tile.size}px`
      img.style.height = `${tile.size}px`
    }

    for (const [key, img] of this.tileNodes) {
      if (!seen.has(key)) {
        img.remove()
        this.tileNodes.delete(key)
      }
    }

    this.highlightsLayer.innerHTML = ''
    if (this.highlightParcel) {
      const rect = parcelScreenRect(this.highlightParcel.px, this.highlightParcel.py, w, h, this.view)
      if (rect) {
        const el = document.createElement('div')
        el.className = 'dcl-map__parcel-highlight'
        el.style.left = `${rect.left}px`
        el.style.top = `${rect.top}px`
        el.style.width = `${rect.size}px`
        el.style.height = `${rect.size}px`
        this.highlightsLayer.appendChild(el)
      }
    }

    const markerPeers = this.allPlayerRows()
    const seenMarkers = new Set<string>()
    for (const peer of markerPeers) {
      seenMarkers.add(peer.address)
      const parcelKey = parcelKeyFromPeer(peer)
      const rect = playerMarkerRect(parcelKey, peer.position, w, h, this.view)
      if (!rect) continue

      let btn = this.markerNodes.get(peer.address)
      if (!btn) {
        btn = document.createElement('button')
        btn.type = 'button'
        btn.className = 'dcl-map__marker'
        btn.addEventListener('pointerdown', (ev) => ev.stopPropagation())
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation()
          this.highlightedPlayer = peer.address
          this.playerSearchInput.value = ''
          this.playerSearch = ''
          this.renderSidebar()
          this.renderFrame()
        })
        this.markersLayer.appendChild(btn)
        this.markerNodes.set(peer.address, btn)
      }

      const name = this.profileForPeer(peer)
      const selected = this.highlightedPlayer === peer.address
      btn.className = `dcl-map__marker${selected ? ' dcl-map__marker--selected' : ''}`
      btn.style.left = `${rect.left}px`
      btn.style.top = `${rect.top}px`
      btn.style.width = `${rect.size}px`
      btn.style.height = `${rect.size}px`
      btn.title = `${name} · ${parcelKey}`
      btn.setAttribute('aria-label', `${name} at ${parcelKey}`)
      btn.setAttribute('aria-pressed', selected ? 'true' : 'false')
      btn.innerHTML = renderAvatar(name, this.faceUrlForPeer(peer), rect.size)
    }

    for (const [address, btn] of this.markerNodes) {
      if (!seenMarkers.has(address)) {
        btn.remove()
        this.markerNodes.delete(address)
      }
    }
  }

  private onPointerDown = (ev: PointerEvent): void => {
    if (ev.button !== 0) return
    ev.preventDefault()
    this.dragRef = {
      pointerId: ev.pointerId,
      startX: ev.clientX,
      startY: ev.clientY,
      panX: this.view.panX,
      panY: this.view.panY,
      moved: false
    }
    this.viewport.setPointerCapture(ev.pointerId)
    window.addEventListener('pointermove', this.onPointerMove)
    window.addEventListener('pointerup', this.onPointerUp)
    window.addEventListener('pointercancel', this.onPointerUp)
  }

  private onPointerMove = (ev: PointerEvent): void => {
    const drag = this.dragRef
    if (!drag || ev.pointerId !== drag.pointerId) return
    const dx = ev.clientX - drag.startX
    const dy = ev.clientY - drag.startY
    if (!drag.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      drag.moved = true
      this.viewport.classList.add('is-dragging')
    }
    if (!drag.moved) return
    ev.preventDefault()
    this.view = {
      ...this.view,
      panX: drag.panX - dx,
      panY: drag.panY - dy
    }
    this.renderFrame()
  }

  private onPointerUp = (ev: PointerEvent): void => {
    const drag = this.dragRef
    if (!drag || ev.pointerId !== drag.pointerId) return

    const moved = drag.moved
    this.endDragSession()

    if (moved) return

    const rect = this.viewport.getBoundingClientRect()
    const sx = ev.clientX - rect.left
    const sy = ev.clientY - rect.top
    const hit = screenPointToParcel(sx, sy, this.viewSize.w, this.viewSize.h, this.view)
    if (!hit) return

    const fetchId = ++this.parcelFetchGen
    this.highlightParcel = { px: hit.px, py: hit.py }
    this.parcelPopup?.showLoading()
    this.renderFrame()

    void fetchParcelInfo(hit.px, hit.py)
      .then((info) => {
        if (this.parcelFetchGen !== fetchId) return
        this.parcelPopup?.showParcel(info)
      })
      .catch((e) => {
        if (this.parcelFetchGen !== fetchId) return
        const message = e instanceof Error ? e.message : String(e)
        this.parcelPopup?.showError(message)
      })
  }

  private endDragSession(): void {
    const drag = this.dragRef
    this.dragRef = null
    this.viewport.classList.remove('is-dragging')
    window.removeEventListener('pointermove', this.onPointerMove)
    window.removeEventListener('pointerup', this.onPointerUp)
    window.removeEventListener('pointercancel', this.onPointerUp)
    if (drag && this.viewport.hasPointerCapture(drag.pointerId)) {
      this.viewport.releasePointerCapture(drag.pointerId)
    }
  }

  private closeParcelPopup(): void {
    this.parcelFetchGen += 1
    this.highlightParcel = null
    this.parcelPopup?.hide()
    this.renderFrame()
  }

  private onWheel = (ev: WheelEvent): void => {
    ev.preventDefault()
    this.view = {
      ...this.view,
      zoom:
        ev.deltaY < 0 && this.view.zoom < VIEWPORT_MAX_ZOOM
          ? this.view.zoom + 1
          : ev.deltaY > 0 && this.view.zoom > VIEWPORT_MIN_ZOOM
            ? this.view.zoom - 1
            : this.view.zoom
    }
    this.renderFrame()
  }
}

function renderAvatar(name: string, imageUrl: string | null | undefined, size: number): string {
  const initial = (name.trim()[0] ?? '?').toUpperCase()
  if (imageUrl) {
    return `<img class="dcl-map__avatar-img" src="${escapeAttr(imageUrl)}" alt="" width="${size}" height="${size}" loading="lazy" decoding="async" />`
  }
  return `<span class="dcl-map__avatar-fallback" aria-hidden style="width:${size}px;height:${size}px">${escapeHtml(initial)}</span>`
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
