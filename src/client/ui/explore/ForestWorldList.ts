import { worldDisplayName, type WorldMapEntry } from '../../../map/worldsCatalog'

export class ForestWorldList {
  readonly root: HTMLElement
  private readonly scroll: HTMLDivElement
  private readonly search: HTMLInputElement
  private selected: string | null = null
  private onPick: ((worldName: string) => void) | null = null
  private entries: WorldMapEntry[] = []
  private query = ''

  constructor() {
    this.root = document.createElement('aside')
    this.root.className = 'forest-world-list'
    this.root.setAttribute('aria-label', 'Worlds')

    const head = document.createElement('header')
    head.className = 'forest-world-list__head'
    head.textContent = 'Worlds'

    const searchWrap = document.createElement('div')
    searchWrap.className = 'forest-world-list__search'
    this.search = document.createElement('input')
    this.search.type = 'search'
    this.search.className = 'forest-world-list__search-input'
    this.search.placeholder = 'Search worlds…'
    this.search.autocomplete = 'off'
    this.search.spellcheck = false
    this.search.setAttribute('aria-label', 'Search worlds')
    this.search.addEventListener('input', this.onSearch)
    this.search.addEventListener('keydown', (ev) => ev.stopPropagation())
    searchWrap.appendChild(this.search)

    this.scroll = document.createElement('div')
    this.scroll.className = 'forest-world-list__scroll'
    this.scroll.addEventListener('click', this.onClick)

    this.root.append(head, searchWrap, this.scroll)
  }

  setOnPick(fn: (worldName: string) => void): void {
    this.onPick = fn
  }

  setWorlds(entries: WorldMapEntry[]): void {
    this.entries = entries
    this.renderRows()
  }

  getSelected(): string | null {
    return this.selected
  }

  setCollapsed(collapsed: boolean): void {
    this.root.classList.toggle('is-collapsed', collapsed)
  }

  setSelected(worldName: string | null): void {
    this.selected = worldName?.toLowerCase() ?? null
    for (const row of this.scroll.querySelectorAll('.forest-world-list__row')) {
      const el = row as HTMLButtonElement
      el.classList.toggle('is-selected', (el.dataset.world ?? '').toLowerCase() === this.selected)
    }
  }

  dispose(): void {
    this.scroll.removeEventListener('click', this.onClick)
    this.search.removeEventListener('input', this.onSearch)
    this.onPick = null
    this.root.remove()
  }

  private onSearch = (): void => {
    this.query = this.search.value.trim().toLowerCase()
    this.renderRows()
  }

  private filtered(): WorldMapEntry[] {
    const q = this.query
    if (!q) return this.entries
    return this.entries.filter((entry) => {
      const name = worldDisplayName(entry).toLowerCase()
      const world = entry.worldName.toLowerCase()
      const title = (entry.title ?? '').toLowerCase()
      return name.includes(q) || world.includes(q) || title.includes(q)
    })
  }

  private renderRows(): void {
    const byName = (a: WorldMapEntry, b: WorldMapEntry) =>
      worldDisplayName(a).localeCompare(worldDisplayName(b), undefined, { sensitivity: 'base' })
    const sorted = [...this.filtered()].sort((a, b) => {
      const au = Math.max(0, a.users | 0)
      const bu = Math.max(0, b.users | 0)
      if (au > 0 && bu > 0) return bu - au || byName(a, b)
      if (au > 0) return -1
      if (bu > 0) return 1
      return byName(a, b)
    })
    this.scroll.replaceChildren()
    if (sorted.length === 0) {
      const empty = document.createElement('p')
      empty.className = 'forest-world-list__empty'
      empty.textContent = this.query ? 'No worlds match' : 'No worlds yet'
      this.scroll.appendChild(empty)
      return
    }
    for (const entry of sorted) {
      const row = document.createElement('button')
      row.type = 'button'
      row.className = 'forest-world-list__row'
      row.dataset.world = entry.worldName
      if (this.selected && this.selected === entry.worldName.toLowerCase()) {
        row.classList.add('is-selected')
      }

      const thumb = document.createElement('span')
      thumb.className = 'forest-world-list__thumb'
      if (entry.imageUrl) {
        const img = document.createElement('img')
        img.src = entry.imageUrl
        img.alt = ''
        img.loading = 'lazy'
        img.referrerPolicy = 'no-referrer'
        img.addEventListener('error', () => {
          img.remove()
        })
        thumb.appendChild(img)
      }

      const name = document.createElement('span')
      name.className = 'forest-world-list__name'
      name.textContent = worldDisplayName(entry)

      const count = document.createElement('span')
      count.className = 'forest-world-list__count'
      count.textContent = String(Math.max(0, entry.users | 0))

      row.append(thumb, name, count)
      this.scroll.appendChild(row)
    }
  }

  private onClick = (ev: Event): void => {
    const btn = (ev.target as HTMLElement | null)?.closest('.forest-world-list__row')
    if (!(btn instanceof HTMLButtonElement)) return
    const name = btn.dataset.world?.trim()
    if (!name) return
    const key = name.toLowerCase()
    if (this.selected === key) {
      this.setSelected(null)
      this.onPick?.('')
      return
    }
    this.setSelected(name)
    this.onPick?.(name)
  }
}
