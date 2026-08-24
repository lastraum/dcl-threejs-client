/**
 * On-device log chip (top-center, closed) + ship logs to the Vite/Mac sink.
 * Enable: `?phonelogs` or `?avatarverbose`.
 *
 * Phone → Mac: POST /__phone-logs (Vite) and :5174 sidecar. No clipboard needed.
 */
import { clientDebugLog } from './ClientDebugLog'

export function shouldMountPhoneLogHud(): boolean {
  if (typeof window === 'undefined') return false
  try {
    const p = new URLSearchParams(window.location.search)
    return p.has('phonelogs') || p.has('avatarverbose') || p.has('consolelogs')
  } catch {
    return false
  }
}

const MAX_HUD = 200
const SHIP_PATH = '/__phone-logs'

export function mountPhoneLogHud(): void {
  if (typeof document === 'undefined') return
  document.getElementById('phone-log-hud')?.remove()

  const root = document.createElement('div')
  root.id = 'phone-log-hud'
  root.style.cssText = [
    'position:fixed',
    'top:max(6px, env(safe-area-inset-top, 0px))',
    'left:50%',
    'transform:translateX(-50%)',
    'z-index:var(--z-client-debug, 230)',
    'width:max-content',
    'max-width:min(360px, 72vw)',
    'pointer-events:none',
    '-webkit-user-select:none',
    'user-select:none',
    '-webkit-touch-callout:none'
  ].join(';')

  const header = document.createElement('button')
  header.type = 'button'
  header.style.cssText = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'gap:8px',
    'width:max-content',
    'margin:0 auto',
    'padding:8px 14px',
    'border:1px solid rgba(255,255,255,0.18)',
    'border-radius:999px',
    'background:rgba(0,0,0,0.82)',
    'color:#9fefac',
    'font:600 16px/1.2 system-ui,sans-serif',
    'cursor:pointer',
    'pointer-events:auto',
    'touch-action:manipulation',
    '-webkit-tap-highlight-color:transparent'
  ].join(';')

  const title = document.createElement('span')
  title.textContent = 'logs (0)'
  const chevron = document.createElement('span')
  chevron.textContent = '▸'
  header.append(title, chevron)

  const body = document.createElement('div')
  body.hidden = true
  body.style.cssText = [
    'display:none',
    'margin-top:6px',
    'width:min(360px, 72vw)',
    'max-height:28vh',
    'overflow:hidden',
    'border-radius:12px',
    'background:rgba(0,0,0,0.9)',
    'color:#9fefac',
    'font:13px/1.35 ui-monospace,Menlo,monospace',
    'pointer-events:auto',
    'touch-action:manipulation'
  ].join(';')

  const pre = document.createElement('pre')
  pre.style.cssText = [
    'margin:0',
    'padding:8px 10px 0',
    'max-height:calc(28vh - 48px)',
    'overflow:auto',
    'white-space:pre-wrap',
    'word-break:break-word',
    '-webkit-user-select:text',
    'user-select:text'
  ].join(';')
  pre.textContent = '(empty)'

  const copy = document.createElement('button')
  copy.type = 'button'
  copy.textContent = 'Copy all'
  copy.style.cssText = [
    'display:block',
    'width:calc(100% - 16px)',
    'margin:8px',
    'padding:12px 12px',
    'border:1px solid rgba(255,255,255,0.22)',
    'border-radius:8px',
    'background:rgba(255,255,255,0.12)',
    'color:#fff',
    'font:600 16px/1.2 system-ui,sans-serif',
    'cursor:pointer',
    'pointer-events:auto',
    'touch-action:manipulation'
  ].join(';')

  body.append(pre, copy)
  root.append(header, body)
  document.body.appendChild(root)

  let open = false
  const lines: string[] = []
  const pending: string[] = []
  let shipTimer = 0

  const render = (): void => {
    title.textContent = `logs (${lines.length})`
    chevron.textContent = open ? '▾' : '▸'
    body.hidden = !open
    body.style.display = open ? 'block' : 'none'
    root.style.width = open ? 'min(360px, 72vw)' : 'max-content'
    pre.textContent = lines.length ? lines.join('\n') : '(empty)'
    if (open) pre.scrollTop = pre.scrollHeight
  }

  const blockGame = (ev: Event): void => {
    ev.stopPropagation()
  }
  for (const el of [header, body, copy]) {
    el.addEventListener('pointerdown', blockGame)
    el.addEventListener('touchstart', blockGame, { passive: true })
  }

  header.addEventListener('click', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    open = !open
    render()
  })

  copy.addEventListener('click', (ev) => {
    ev.preventDefault()
    ev.stopPropagation()
    copy.textContent = 'Shipped to Mac'
    flushShip()
    setTimeout(() => {
      copy.textContent = 'Copy all'
    }, 1100)
  })

  const pushLine = (text: string): void => {
    const line = text.slice(0, 1500)
    if (!line) return
    lines.push(line)
    if (lines.length > MAX_HUD) lines.splice(0, lines.length - MAX_HUD)
    pending.push(line)
    render()
    if (pending.length >= 8) {
      flushShip()
      return
    }
    if (!shipTimer) {
      shipTimer = window.setTimeout(() => {
        shipTimer = 0
        flushShip()
      }, 200)
    }
  }

  const flushShip = (): void => {
    if (shipTimer) {
      window.clearTimeout(shipTimer)
      shipTimer = 0
    }
    if (!pending.length) return
    const batch = pending.splice(0, pending.length)
    const payload = JSON.stringify({ lines: batch })
    const blob = new Blob([payload], { type: 'text/plain' })
    const sidecar = `${window.location.protocol}//${window.location.hostname}:5174${SHIP_PATH}`
    try {
      navigator.sendBeacon?.(SHIP_PATH, blob)
    } catch {
      /* ignore */
    }
    try {
      navigator.sendBeacon?.(sidecar, blob)
    } catch {
      /* ignore */
    }
    void fetch(SHIP_PATH, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'text/plain' },
      keepalive: true,
      mode: 'same-origin'
    }).catch(() => {})
    void fetch(sidecar, {
      method: 'POST',
      body: payload,
      headers: { 'Content-Type': 'text/plain' },
      keepalive: true,
      mode: 'cors'
    }).catch(() => {})
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushShip()
  })
  window.addEventListener('pagehide', () => flushShip())

  const fmt = (args: unknown[]): string =>
    args
      .map((a) => {
        if (typeof a === 'string') return a
        if (a instanceof Error) return a.stack || a.message
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
      .slice(0, 1500)

  const wrap =
    (kind: string, orig: (...a: unknown[]) => void) =>
    (...args: unknown[]) => {
      const t = new Date().toISOString().slice(11, 23)
      pushLine(`${t} ${kind} ${fmt(args)}`)
      orig.apply(console, args)
    }
  console.log = wrap('L', console.log.bind(console))
  console.info = wrap('I', console.info.bind(console))
  console.warn = wrap('W', console.warn.bind(console))
  console.error = wrap('E', console.error.bind(console))

  window.addEventListener('error', (ev) => {
    pushLine(`${new Date().toISOString().slice(11, 23)} E ${ev.message} ${ev.filename}:${ev.lineno}`)
  })
  window.addEventListener('unhandledrejection', (ev) => {
    pushLine(`${new Date().toISOString().slice(11, 23)} E unhandled ${String(ev.reason)}`)
  })

  let seenDebugId = 0
  clientDebugLog.subscribe((entries) => {
    for (const e of entries) {
      if (e.id <= seenDebugId) continue
      seenDebugId = e.id
      pushLine(`${new Date(e.at).toISOString().slice(11, 23)} D [${e.category}] ${e.message}`)
    }
  })

  pushLine(
    `${new Date().toISOString().slice(11, 23)} I [phone-log] shipping → ${SHIP_PATH} and :5174 ua=${navigator.userAgent}`
  )
  render()
}
