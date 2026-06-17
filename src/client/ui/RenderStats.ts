import Stats from 'three/examples/jsm/libs/stats.module.js'

/** mrdoob stats.js — FPS / MS / MB panel for the debug overlay. */
export class RenderStats {
  readonly dom: HTMLElement
  private readonly stats: Stats

  constructor() {
    this.stats = new Stats()
    this.stats.dom.id = 'render-stats'
    this.dom = this.stats.dom
  }

  begin(): void {
    this.stats.begin()
  }

  end(): void {
    this.stats.end()
  }

  update(): void {
    this.stats.update()
  }
}
