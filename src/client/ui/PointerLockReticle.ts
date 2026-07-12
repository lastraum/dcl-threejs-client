import { POINTER_LOCK_AIM_NDC_Y, pointerLockAim, setPointerLockAimFromCanvas } from '../../input/pointerLockAim'

/**
 * Fixed on-screen aim marker while pointer-locked (above canvas center).
 */
export class PointerLockReticle {
  private readonly root: HTMLElement
  private readonly canvas: HTMLElement
  private readonly onResize: () => void
  private visible = false

  constructor(canvas: HTMLElement) {
    this.canvas = canvas
    this.root = document.createElement('div')
    this.root.className = 'pointer-lock-reticle'
    this.root.hidden = true
    this.root.setAttribute('aria-hidden', 'true')
    this.root.innerHTML = `
      <span class="pointer-lock-reticle__ring" aria-hidden="true"></span>
      <span class="pointer-lock-reticle__dot" aria-hidden="true"></span>
    `
    document.body.appendChild(this.root)

    this.onResize = () => {
      if (this.visible) this.layout()
    }
    window.addEventListener('resize', this.onResize)
  }

  setVisible(visible: boolean): void {
    if (this.visible === visible) {
      if (visible) this.layout()
      return
    }
    this.visible = visible
    this.root.hidden = !visible
    if (visible) this.layout()
  }

  /** Re-apply fixed canvas position (after resize / each lock frame). */
  syncLayout(): void {
    if (this.visible) this.layout()
  }

  private layout(): void {
    const rect = this.canvas.getBoundingClientRect()
    if (rect.width < 1 || rect.height < 1) {
      this.root.style.left = '50%'
      this.root.style.top = `${(0.5 - POINTER_LOCK_AIM_NDC_Y * 0.5) * 100}%`
      return
    }
    setPointerLockAimFromCanvas(rect)
    this.root.style.left = `${pointerLockAim.clientX}px`
    this.root.style.top = `${pointerLockAim.clientY}px`
  }

  dispose(): void {
    window.removeEventListener('resize', this.onResize)
    this.root.remove()
  }
}
