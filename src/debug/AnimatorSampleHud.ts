import type { AnimatorSampleStats } from '../bridge/AnimatorBridge'

/**
 * Opt-in bottom-right counter for scene animator phase-slice stats
 * (`?animatorhud` / `?perf`). Explains display FPS vs sample rate vs share fan-out.
 */
export class AnimatorSampleHud {
  private el: HTMLDivElement | null = null
  private disposed = false

  private ensureEl(): HTMLDivElement | null {
    if (this.disposed) return null
    if (this.el) return this.el
    const el = document.createElement('div')
    el.id = 'animator-sample-hud'
    el.setAttribute('aria-live', 'polite')
    // Bottom-right — do not cover stats.js FPS / debug panel (top-right).
    el.style.cssText = [
      'position:fixed',
      'bottom:12px',
      'right:12px',
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
    el.textContent = 'animators…'
    document.body.appendChild(el)
    this.el = el
    return el
  }

  setDisabled(reason = 'OFF (?noanim)'): void {
    const el = this.ensureEl()
    if (!el) return
    el.innerHTML =
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
    const el = this.ensureEl()
    if (!el) return
    const fps = stats.displayFps > 0 ? stats.displayFps.toFixed(0) : '—'
    const farHz = stats.fair > 0 ? stats.fairSampleHz.toFixed(0) : '—'
    const nearHz = stats.displayFps > 0 ? stats.displayFps.toFixed(0) : '—'
    const shared =
      stats.sharedGroups != null
        ? `${stats.sharedGroups}g +${stats.sharedFanout ?? 0}`
        : '—'
    el.innerHTML = [
      `<div style="opacity:.9;font-weight:600;margin-bottom:3px">animators</div>`,
      row('display', `${fps} fps`),
      row('bound', String(stats.bound)),
      row('active', String(stats.active)),
      row('sleep', String(stats.sleeping ?? 0)),
      row('near', `${stats.near} @ ~${nearHz} Hz`),
      row('fair', `${stats.fair} @ ~${farHz} Hz`),
      row('shared', shared),
      row('sampled', `${stats.sampled} / ${stats.budget}`),
      row('deferred', String(stats.deferred)),
      `<div style="opacity:.55;margin-top:5px;font-size:10px;max-width:200px;white-space:normal">` +
        `shared = 1 mixer.update per hash → pose fan-out. fair Hz target ≥30 in view.` +
        `</div>`
    ].join('')
  }

  dispose(): void {
    this.disposed = true
    this.el?.remove()
    this.el = null
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
