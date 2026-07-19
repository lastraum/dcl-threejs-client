/**
 * Photo-mode viewfinder HUD — frame, shutter, person count, exit.
 * Only visible while In-World Camera mode is active.
 */

export type PhotoCameraHudHandlers = {
  onShutter: () => void
  onExit: () => void
}

export class PhotoCameraHud {
  readonly root: HTMLDivElement
  private readonly statusEl: HTMLSpanElement
  private readonly peopleEl: HTMLSpanElement
  private readonly flashEl: HTMLDivElement
  private visible = false

  constructor(private readonly handlers: PhotoCameraHudHandlers) {
    this.root = document.createElement('div')
    this.root.id = 'photo-camera-hud'
    this.root.className = 'photo-camera-hud'
    this.root.hidden = true
    this.root.innerHTML = `
      <div class="photo-camera-hud__frame" data-frame aria-hidden="true"></div>
      <div class="photo-camera-hud__top">
        <span class="photo-camera-hud__badge">CAMERA</span>
        <span class="photo-camera-hud__people" data-people></span>
      </div>
      <div class="photo-camera-hud__bottom">
        <p class="photo-camera-hud__hints">
          WASD fly · R/F up/down · Shift fast · Ctrl slow · scroll FOV · mouse look · Space photo · Esc/C exit
        </p>
        <div class="photo-camera-hud__actions">
          <button type="button" class="photo-camera-hud__btn photo-camera-hud__btn--exit" data-exit>Exit</button>
          <button type="button" class="photo-camera-hud__btn photo-camera-hud__btn--shutter" data-shutter aria-label="Take photo">
            <span class="photo-camera-hud__shutter-ring"></span>
          </button>
        </div>
        <span class="photo-camera-hud__status" data-status></span>
      </div>
      <div class="photo-camera-hud__flash" data-flash hidden></div>
    `
    this.statusEl = this.root.querySelector('[data-status]')!
    this.peopleEl = this.root.querySelector('[data-people]')!
    this.flashEl = this.root.querySelector('[data-flash]')!

    this.root.querySelector('[data-exit]')!.addEventListener('click', (e) => {
      e.stopPropagation()
      this.handlers.onExit()
    })
    this.root.querySelector('[data-shutter]')!.addEventListener('click', (e) => {
      e.stopPropagation()
      this.handlers.onShutter()
    })

    document.body.appendChild(this.root)
  }

  show(): void {
    this.visible = true
    this.root.hidden = false
    this.setStatus('')
  }

  hide(): void {
    this.visible = false
    this.root.hidden = true
    this.flashEl.hidden = true
  }

  isVisible(): boolean {
    return this.visible
  }

  /** Hide chrome for one capture frame (frame still guides crop via CSS vars). */
  setCaptureChromeVisible(visible: boolean): void {
    this.root.classList.toggle('is-capturing', !visible)
  }

  setPeopleCount(n: number): void {
    if (n <= 0) {
      this.peopleEl.textContent = ''
      return
    }
    this.peopleEl.textContent = n === 1 ? '1 person in frame' : `${n} people in frame`
  }

  setStatus(text: string): void {
    this.statusEl.textContent = text
  }

  playFlash(): void {
    this.flashEl.hidden = false
    this.flashEl.classList.remove('is-on')
    // force reflow
    void this.flashEl.offsetWidth
    this.flashEl.classList.add('is-on')
    window.setTimeout(() => {
      this.flashEl.classList.remove('is-on')
      this.flashEl.hidden = true
    }, 280)
  }

  dispose(): void {
    this.root.remove()
  }
}
