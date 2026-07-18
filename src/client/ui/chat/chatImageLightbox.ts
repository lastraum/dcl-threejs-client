/**
 * Near-fullscreen lightbox for chat-shared images.
 * Singleton overlay — click chat thumbnails to open; Esc / backdrop / × to close.
 */

const OVERLAY_ID = 'chat-image-lightbox'

let overlayEl: HTMLDivElement | null = null
let imgEl: HTMLImageElement | null = null
let open = false

function ensureOverlay(): HTMLDivElement {
  if (overlayEl?.isConnected) return overlayEl

  const root = document.createElement('div')
  root.id = OVERLAY_ID
  root.className = 'chat-image-lightbox'
  root.hidden = true
  root.setAttribute('role', 'dialog')
  root.setAttribute('aria-modal', 'true')
  root.setAttribute('aria-label', 'Expanded chat image')

  root.innerHTML = `
    <button type="button" class="chat-image-lightbox__close" aria-label="Close">×</button>
    <div class="chat-image-lightbox__stage">
      <img class="chat-image-lightbox__img" alt="Chat image" draggable="false" />
    </div>
  `

  const closeBtn = root.querySelector('.chat-image-lightbox__close') as HTMLButtonElement
  imgEl = root.querySelector('.chat-image-lightbox__img') as HTMLImageElement

  const close = (): void => closeChatImageLightbox()
  closeBtn.addEventListener('click', (e) => {
    e.stopPropagation()
    close()
  })
  root.addEventListener('click', (e) => {
    if (e.target === root || (e.target as HTMLElement).classList.contains('chat-image-lightbox__stage')) {
      close()
    }
  })
  imgEl.addEventListener('click', (e) => e.stopPropagation())

  document.body.appendChild(root)
  overlayEl = root
  return root
}

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && open) {
    e.preventDefault()
    e.stopPropagation()
    closeChatImageLightbox()
  }
}

export function openChatImageLightbox(src: string, alt = 'Chat image'): void {
  const url = src?.trim()
  if (!url) return

  if (document.pointerLockElement) document.exitPointerLock()

  const root = ensureOverlay()
  // Re-append last so we win paint order against late-mounted chat chrome.
  if (root.parentElement === document.body) {
    document.body.appendChild(root)
  }
  if (imgEl) {
    imgEl.src = url
    imgEl.alt = alt
  }
  root.hidden = false
  open = true
  document.body.classList.add('chat-image-lightbox-open')
  window.addEventListener('keydown', onKeyDown, true)
}

export function closeChatImageLightbox(): void {
  if (!open) return
  open = false
  if (overlayEl) overlayEl.hidden = true
  if (imgEl) {
    imgEl.removeAttribute('src')
    imgEl.alt = ''
  }
  document.body.classList.remove('chat-image-lightbox-open')
  window.removeEventListener('keydown', onKeyDown, true)
}

export function isChatImageLightboxOpen(): boolean {
  return open
}

/** Wire a chat thumbnail — click opens the lightbox. */
export function wireChatImageExpand(img: HTMLImageElement, src?: string): void {
  img.classList.add('chat-panel__image--expandable')
  img.title = 'Click to expand'
  img.setAttribute('role', 'button')
  img.tabIndex = 0
  const open = (e: Event): void => {
    e.preventDefault()
    e.stopPropagation()
    openChatImageLightbox(src || img.currentSrc || img.src, img.alt || 'Chat image')
  }
  img.addEventListener('click', open)
  img.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      open(e)
    }
  })
}
