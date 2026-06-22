import * as THREE from 'three'
import Stats from 'three/examples/jsm/libs/stats.module.js'

export type OceanPerfInfo =
  | { backend: 'water.js'; variant: 'open' | 'island'; planeSpanM: number }
  | {
      backend: 'fft-ocean'
      variant: 'open' | 'island'
      meshResolution: number
      fftResolution: number
      gpgpuPasses: number
      gpgpuHz: number
    }

/** mrdoob stats.js — FPS / MS / MB panel plus optional ocean + draw-call HUD. */
export class RenderStats {
  readonly dom: HTMLDivElement
  private readonly stats: Stats
  private readonly extra: HTMLDivElement
  private oceanInfo: OceanPerfInfo | null = null
  private renderer: THREE.WebGLRenderer | null = null

  constructor() {
    this.stats = new Stats()
    this.stats.dom.id = 'render-stats'

    this.extra = document.createElement('div')
    this.extra.id = 'render-stats-extra'
    this.extra.style.cssText =
      'font:11px/1.35 monospace;color:#9fd3ff;margin-top:4px;white-space:pre;line-height:1.4;'

    this.dom = document.createElement('div')
    this.dom.id = 'render-stats-host'
    this.dom.appendChild(this.stats.dom)
    this.dom.appendChild(this.extra)
    this.refreshExtra()
  }

  attachRenderer(renderer: THREE.WebGLRenderer): void {
    this.renderer = renderer
  }

  setOceanPerf(info: OceanPerfInfo | null): void {
    this.oceanInfo = info
    this.refreshExtra()
  }

  begin(): void {
    this.stats.begin()
  }

  end(): void {
    this.stats.end()
  }

  update(): void {
    this.stats.update()
    this.refreshExtra()
  }

  private refreshExtra(): void {
    const lines: string[] = []
    if (this.oceanInfo) {
      if (this.oceanInfo.backend === 'water.js') {
        lines.push(
          `ocean: Water.js [${this.oceanInfo.variant}] (${this.oceanInfo.planeSpanM}m plane)`
        )
      } else {
        lines.push(
          `ocean: FFTOCEAN [${this.oceanInfo.variant}] mesh=${this.oceanInfo.meshResolution} fft=${this.oceanInfo.fftResolution}`,
          `gpgpu: ${this.oceanInfo.gpgpuPasses} passes @ ${this.oceanInfo.gpgpuHz}Hz`
        )
      }
    }
    if (this.renderer) {
      const { render } = this.renderer.info
      lines.push(`draws: ${render.calls}  tris: ${render.triangles}`)
    }
    this.extra.textContent = lines.join('\n')
  }
}