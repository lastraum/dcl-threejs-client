export type TerrainSurfaceProbe = {
  heightM: number
  slope: number
}

/** Bottom-left terrain probe — mesh Y (m) under cursor and local slope %. */
export class EditorTerrainHeightHud {
  private readonly root: HTMLDivElement

  constructor(parent: HTMLElement) {
    this.root = document.createElement('div')
    this.root.className = 'editor-terrain-height-hud'
    this.root.textContent = 'Y — · slope —'
    parent.appendChild(this.root)
  }

  setProbe(probe: TerrainSurfaceProbe | null): void {
    if (!probe) {
      this.root.textContent = 'Y — · slope —'
      return
    }
    const slopePct = Math.round(probe.slope * 100)
    this.root.textContent = `Y ${probe.heightM.toFixed(1)} m · slope ${slopePct}%`
  }

  dispose(): void {
    this.root.remove()
  }
}