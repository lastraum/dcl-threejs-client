import type { AnimatorSampleStats } from '../bridge/AnimatorBridge'

/**
 * Always-on top-right counter for scene animator phase-slice stats.
 * Explains display FPS vs sample rate vs time-correct clip speed.
 */
export class AnimatorSampleHud {
  private readonly el: HTMLDivElement
  private disposed = false

  constructor() {
    this.el = document.createElement('div')
    this.el.id = 'animator-sample-hud'
    this.el.setAttribute('aria-live', 'polite')
    this.el.style.cssText = [
      'position:fixed',
      'top:10px',
      'right:10px',
      'z-index:10050',
      'pointer-events:none',
      'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
      'color:#e8f0ff',
      'background:rgba(8,12,22,0.78)',
      'border:1px solid rgba(120,160,255,0.35)',
      'border-radius:8px',
      'padding:8px 10px',
      'min-width:168px',
      'backdrop-filter:blur(6px)',
      'box-shadow:0 4px 18px rgba(0,0,0,0.35)',
      'white-space:pre'
    ].join(';')
    this.el.textContent = 'animators…'
    document.body.appendChild(this.el)
  }

  setDisabled(reason = 'OFF (?noanim)'): void {
    if (this.disposed) return
    this.el.innerHTML =
      `<div style="opacity:.85;margin-bottom:2px">animators</div>` +
      `<div style="color:#f6c177">${escapeHtml(reason)}</div>` +
      `<div style="opacity:.65;margin-top:4px;font-size:10px">clips frozen</div>`
  }

  update(stats: AnimatorSampleStats): void {
    if (this.disposed) return
    if (stats.disabled) {
      this.setDisabled()
      return
    }
    const fps = stats.displayFps > 0 ? stats.displayFps.toFixed(0) : '—'
    const farHz = stats.fair > 0 ? stats.fairSampleHz.toFixed(0) : '—'
    const nearHz = stats.displayFps > 0 ? stats.displayFps.toFixed(0) : '—'
    this.el.innerHTML = [
      `<div style="opacity:.9;font-weight:600;margin-bottom:3px">animators</div>`,
      row('display', `${fps} fps`),
      row('bound', String(stats.bound)),
      row('active', String(stats.active)),
      row('near', `${stats.near} @ ~${nearHz} Hz`),
      row('fair', `${stats.fair} @ ~${farHz} Hz`),
      row('sampled', `${stats.sampled} / ${stats.budget}`),
      row('deferred', String(stats.deferred)),
      `<div style="opacity:.55;margin-top:5px;font-size:10px;max-width:200px;white-space:normal">` +
        `far Hz = sample rate (time-correct speed). display ≠ anim speed.` +
        `</div>`
    ].join('')
  }

  dispose(): void {
    this.disposed = true
    this.el.remove()
  }
}

function row(label: string, value: string): string {
  return (
    `<div style="display:flex;justify-content:space-between;gap:12px">` +
    `<span style="opacity:.65">${escapeHtml(label)}</span>` +
    `<span>${escapeHtml(value)}</span></div>`
  )
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
