import type { RouteTarget } from '../dcl/content/route'
import { findChatLinks } from './chatNavigationLinks'

export type LinkifyChatOptions = {
  linkClass?: string
  navLinkClass?: string
  onNavigate?: (target: RouteTarget) => void
}

const DEFAULT_LINK_CLASS = 'chat-panel__link'

/**
 * Append chat message text with http(s) links, parcel coords, `.dcl.eth` names, and
 * Decentraland play URLs — nav links call `onNavigate` (teleport) instead of opening a tab.
 */
export function appendLinkifiedText(
  container: HTMLElement,
  text: string,
  opts: LinkifyChatOptions | string = {}
): void {
  const options: LinkifyChatOptions = typeof opts === 'string' ? { linkClass: opts } : opts
  const linkClass = options.linkClass ?? DEFAULT_LINK_CLASS
  const navLinkClass = options.navLinkClass ?? linkClass
  const matches = findChatLinks(text)

  if (!matches.length) {
    container.textContent = text
    return
  }

  let last = 0
  for (const m of matches) {
    if (m.start > last) {
      container.appendChild(document.createTextNode(text.slice(last, m.start)))
    }

    const tail = text.slice(m.start + m.raw.length, m.end)
    const anchor = document.createElement('a')
    anchor.className = m.target ? navLinkClass : linkClass
    anchor.textContent = m.raw

    if (m.target && options.onNavigate) {
      anchor.href = '#'
      anchor.addEventListener('click', (ev) => {
        ev.preventDefault()
        options.onNavigate?.(m.target!)
      })
    } else if (m.target) {
      anchor.href = '#'
    } else {
      anchor.href = m.href
      anchor.target = '_blank'
      anchor.rel = 'noopener noreferrer'
    }

    container.appendChild(anchor)
    if (tail) {
      container.appendChild(document.createTextNode(tail))
    }
    last = m.end
  }

  if (last < text.length) {
    container.appendChild(document.createTextNode(text.slice(last)))
  }
}
