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
    const root = document.documentElement
    // Phone + iPad: no persistent rail. Profile FAB width lives in CSS
    // (`html.client-mobile` / `html.client-tablet`) so inline 48px does not
    // clobber the tablet token. `--client-safe-left` follows the FAB.
    if (root.classList.contains('client-mobile')) {
      root.style.setProperty('--client-sidebar-w', '0px')
      root.style.removeProperty('--client-mobile-profile-w')
      return
    }
    const el = this.sidebar
    if (!el) return
    const w = el.getBoundingClientRect().width
    if (w <= 0) return
    root.style.setProperty('--client-sidebar-w', `${w}px`)
    root.style.removeProperty('--client-mobile-profile-w')
  }
}
