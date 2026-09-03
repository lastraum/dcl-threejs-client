import {
  fetchProfileLambdaEntryCached,
  resolveFaceSnapshotUrl
} from '../../../avatar/peerApi'
import { shortenAddress } from '../../../avatar/displayName'
import { worldDisplayName, type WorldMapEntry } from '../../../map/worldsCatalog'

type UserRow = {
  address: string
  name: string
  faceUrl: string | null
}

export class ForestWorldPanel {
  readonly root: HTMLElement
  private readonly hero: HTMLDivElement
  private readonly img: HTMLImageElement
  private readonly titleEl: HTMLHeadingElement
  private readonly creatorEl: HTMLDivElement
  private readonly creatorFace: HTMLSpanElement
  private readonly creatorName: HTMLSpanElement
  private readonly descEl: HTMLParagraphElement
  private readonly countEl: HTMLParagraphElement
  private readonly users: HTMLDivElement
  private readonly jump: HTMLButtonElement
  private entry: WorldMapEntry | null = null
  private gen = 0
  private onJump: ((worldName: string) => void) | null = null

  constructor() {
    this.root = document.createElement('aside')
    this.root.className = 'forest-world-panel'
    this.root.setAttribute('aria-label', 'World')
    this.root.hidden = true

    this.hero = document.createElement('div')
    this.hero.className = 'forest-world-panel__hero'

    this.img = document.createElement('img')
    this.img.alt = ''
    this.img.referrerPolicy = 'no-referrer'
    this.img.addEventListener('error', () => {
      this.img.removeAttribute('src')
      this.img.hidden = true
    })
    this.hero.appendChild(this.img)

    const body = document.createElement('div')
    body.className = 'forest-world-panel__body'

    this.titleEl = document.createElement('h2')
    this.titleEl.className = 'forest-world-panel__title'

    this.creatorEl = document.createElement('div')
    this.creatorEl.className = 'forest-world-panel__creator'
    this.creatorEl.hidden = true
    this.creatorFace = document.createElement('span')
    this.creatorFace.className = 'forest-world-panel__creator-face'
    const creatorMeta = document.createElement('span')
    creatorMeta.className = 'forest-world-panel__creator-meta'
    const creatorLabel = document.createElement('span')
    creatorLabel.className = 'forest-world-panel__creator-label'
    creatorLabel.textContent = 'Creator'
    this.creatorName = document.createElement('span')
    this.creatorName.className = 'forest-world-panel__creator-name'
    creatorMeta.append(creatorLabel, this.creatorName)
    this.creatorEl.append(this.creatorFace, creatorMeta)

    this.descEl = document.createElement('p')
    this.descEl.className = 'forest-world-panel__desc'
    this.descEl.hidden = true

    this.countEl = document.createElement('p')
    this.countEl.className = 'forest-world-panel__count'

    this.users = document.createElement('div')
    this.users.className = 'forest-world-panel__users'
    this.users.setAttribute('aria-label', 'Players')

    body.append(this.titleEl, this.creatorEl, this.descEl, this.countEl, this.users)

    this.jump = document.createElement('button')
    this.jump.type = 'button'
    this.jump.className = 'forest-world-panel__jump'
    this.jump.textContent = 'Jump In'
    this.jump.addEventListener('click', this.onJumpClick)

    this.root.append(this.hero, body, this.jump)
  }

  setOnJump(fn: (worldName: string) => void): void {
    this.onJump = fn
  }

  isOpen(): boolean {
    return this.root.classList.contains('is-open')
  }

  getWorldName(): string | null {
    return this.entry?.worldName ?? null
  }

  show(entry: WorldMapEntry): void {
    this.entry = entry
    this.root.hidden = false
    this.render(entry)
    requestAnimationFrame(() => this.root.classList.add('is-open'))
  }

  hide(): void {
    this.gen += 1
    this.entry = null
    this.root.classList.remove('is-open')
    window.setTimeout(() => {
      if (!this.entry) this.root.hidden = true
    }, 380)
  }

  refresh(entry: WorldMapEntry): void {
    if (!this.entry) return
    if (entry.worldName.toLowerCase() !== this.entry.worldName.toLowerCase()) return
    this.entry = entry
    this.render(entry)
  }

  dispose(): void {
    this.gen += 1
    this.onJump = null
    this.jump.removeEventListener('click', this.onJumpClick)
    this.root.remove()
  }

  private onJumpClick = (): void => {
    const name = this.entry?.worldName
    if (name) this.onJump?.(name)
  }

  private render(entry: WorldMapEntry): void {
    const gen = ++this.gen
    const title = worldDisplayName(entry)
    this.titleEl.textContent = title
    this.img.alt = title
    if (entry.imageUrl) {
      this.img.src = entry.imageUrl
      this.img.hidden = false
    } else {
      this.img.removeAttribute('src')
      this.img.hidden = true
    }

    const creatorAddr = entry.creatorAddress?.toLowerCase() ?? null
    const creatorLabel = entry.ownerName?.trim() || (creatorAddr ? shortenAddress(creatorAddr) : '')
    if (creatorLabel || creatorAddr) {
      this.creatorEl.hidden = false
      this.creatorName.textContent = creatorLabel || 'Creator'
      this.creatorFace.replaceChildren()
      if (creatorAddr) void this.fillCreator(creatorAddr, gen)
    } else {
      this.creatorEl.hidden = true
      this.creatorName.textContent = ''
      this.creatorFace.replaceChildren()
    }

    const desc = entry.description?.trim() ?? ''
    if (desc) {
      this.descEl.hidden = false
      this.descEl.textContent = desc
    } else {
      this.descEl.hidden = true
      this.descEl.textContent = ''
    }

    const n = Math.max(0, entry.users | 0)
    this.countEl.textContent = n === 1 ? '1 player' : `${n} players`
    this.jump.disabled = !entry.worldName

    const addrs = (entry.connectedAddresses ?? []).map((a) => a.toLowerCase())
    this.users.replaceChildren()
    if (!addrs.length) {
      const empty = document.createElement('p')
      empty.className = 'forest-world-panel__empty'
      empty.textContent = n > 0 ? 'Loading players…' : 'No one here yet'
      this.users.appendChild(empty)
      return
    }
    for (const address of addrs) {
      this.users.appendChild(this.makeRow({ address, name: shortenAddress(address), faceUrl: null }))
    }
    void this.fillNames(addrs, gen)
  }

  private async fillCreator(address: string, gen: number): Promise<void> {
    try {
      const lambda = await fetchProfileLambdaEntryCached(address)
      if (gen !== this.gen) return
      const display =
        (lambda?.hasClaimedName && lambda.name?.trim()) ||
        lambda?.name?.trim() ||
        lambda?.unclaimedName?.trim() ||
        this.entry?.ownerName?.trim() ||
        shortenAddress(address)
      this.creatorName.textContent = display
      const faceUrl = resolveFaceSnapshotUrl(lambda?.avatar?.snapshots?.face256)
      if (faceUrl && !this.creatorFace.querySelector('img')) {
        const img = document.createElement('img')
        img.src = faceUrl
        img.alt = ''
        this.creatorFace.appendChild(img)
      }
    } catch {
      /* keep owner / shortened address */
    }
  }

  private makeRow(row: UserRow): HTMLDivElement {
    const el = document.createElement('div')
    el.className = 'forest-world-panel__user'
    el.dataset.address = row.address

    const face = document.createElement('span')
    face.className = 'forest-world-panel__face'
    if (row.faceUrl) {
      const img = document.createElement('img')
      img.src = row.faceUrl
      img.alt = ''
      face.appendChild(img)
    }

    const name = document.createElement('span')
    name.className = 'forest-world-panel__user-name'
    name.textContent = row.name

    el.append(face, name)
    return el
  }

  private async fillNames(addrs: string[], gen: number): Promise<void> {
    const parallel = 8
    for (let i = 0; i < addrs.length; i += parallel) {
      if (gen !== this.gen) return
      const batch = addrs.slice(i, i + parallel)
      await Promise.all(batch.map((address) => this.fillOne(address, gen)))
    }
  }

  private async fillOne(address: string, gen: number): Promise<void> {
    try {
      const lambda = await fetchProfileLambdaEntryCached(address)
      if (gen !== this.gen) return
      const row = this.users.querySelector(`[data-address="${address}"]`)
      if (!(row instanceof HTMLElement)) return
      const nameEl = row.querySelector('.forest-world-panel__user-name')
      const faceEl = row.querySelector('.forest-world-panel__face')
      const display =
        (lambda?.hasClaimedName && lambda.name?.trim()) ||
        lambda?.name?.trim() ||
        lambda?.unclaimedName?.trim() ||
        shortenAddress(address)
      if (nameEl) nameEl.textContent = display
      const faceUrl = resolveFaceSnapshotUrl(lambda?.avatar?.snapshots?.face256)
      if (faceUrl && faceEl && !faceEl.querySelector('img')) {
        const img = document.createElement('img')
        img.src = faceUrl
        img.alt = ''
        faceEl.appendChild(img)
      }
    } catch {
      /* keep shortened address */
    }
  }
}
