/** Syncs measured client chrome dimensions to CSS custom properties on `:root`. */
export class ClientUiLayout {
  private sidebar: HTMLElement | null = null
  private observer: ResizeObserver | null = null
  private readonly onWindowResize = (): void => {
    this.syncSidebarWidth()
  }

  /** Observe `#client-shell` width → `--client-sidebar-w` (panels use `--client-safe-left`). */
  attach(sidebar: HTMLElement): void {
    this.detach()
    this.sidebar = sidebar
    this.syncSidebarWidth()
    this.observer = new ResizeObserver(() => this.syncSidebarWidth())
    this.observer.observe(sidebar)
    window.addEventListener('resize', this.onWindowResize, { passive: true })
  }

  detach(): void {
    this.observer?.disconnect()
    this.observer = null
    window.removeEventListener('resize', this.onWindowResize)
    this.sidebar = null
  }

  private syncSidebarWidth(): void {
    const el = this.sidebar
    if (!el) return
    const w = el.getBoundingClientRect().width
    if (w <= 0) return
    document.documentElement.style.setProperty('--client-sidebar-w', `${w}px`)
  }
}
