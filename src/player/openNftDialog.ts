import { fetchNftInfo } from '../media/nftInfo'
import { parseNftUrn, openseaAssetPageUrl } from '../media/nftUrn'

export type OpenNftDialogRequest = {
  urn: string
}

export type OpenNftDialogResponse = {
  success: boolean
}

const OVERLAY_ID = 'threejs-nft-dialog-overlay'

/**
 * DCL `RestrictedActions.openNftDialog` — in-page sheet with name/description/owner + OpenSea link.
 * Must be invoked from a scene pointer event (scene responsibility).
 */
export async function openNftDialog(request: OpenNftDialogRequest): Promise<boolean> {
  const urn = request.urn?.trim()
  if (!urn) return false
  if (!parseNftUrn(urn)) return false

  closeNftDialog()

  const overlay = document.createElement('div')
  overlay.id = OVERLAY_ID
  overlay.setAttribute('role', 'dialog')
  overlay.setAttribute('aria-modal', 'true')
  overlay.style.cssText = [
    'position:fixed',
    'inset:0',
    'z-index:10050',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'background:rgba(0,0,0,0.55)',
    'padding:24px',
    'font-family:system-ui,-apple-system,sans-serif'
  ].join(';')

  const card = document.createElement('div')
  card.style.cssText = [
    'max-width:420px',
    'width:100%',
    'background:#1a1a22',
    'color:#f2f2f5',
    'border-radius:14px',
    'box-shadow:0 16px 48px rgba(0,0,0,0.45)',
    'overflow:hidden',
    'border:1px solid rgba(255,255,255,0.08)'
  ].join(';')

  const body = document.createElement('div')
  body.style.cssText = 'padding:16px 18px 18px;display:flex;flex-direction:column;gap:10px'
  body.innerHTML = `<div style="opacity:0.7;font-size:13px">Loading NFT…</div>`

  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.textContent = '×'
  closeBtn.setAttribute('aria-label', 'Close')
  closeBtn.style.cssText = [
    'position:absolute',
    'top:8px',
    'right:12px',
    'background:transparent',
    'border:none',
    'color:#fff',
    'font-size:28px',
    'line-height:1',
    'cursor:pointer',
    'opacity:0.75'
  ].join(';')

  const wrap = document.createElement('div')
  wrap.style.cssText = 'position:relative'
  wrap.appendChild(closeBtn)
  wrap.appendChild(body)
  card.appendChild(wrap)
  overlay.appendChild(card)

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') closeNftDialog()
  }
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeNftDialog()
  })
  closeBtn.addEventListener('click', () => closeNftDialog())
  document.addEventListener('keydown', onKey)
  overlay.dataset.keyHandler = '1'
  ;(overlay as unknown as { _onKey?: (e: KeyboardEvent) => void })._onKey = onKey

  document.body.appendChild(overlay)

  const info = await fetchNftInfo(urn)
  if (!document.getElementById(OVERLAY_ID)) return !!info

  if (!info) {
    body.innerHTML = `
      <div style="font-weight:600;font-size:16px">NFT unavailable</div>
      <div style="opacity:0.7;font-size:13px;word-break:break-all">${escapeHtml(urn)}</div>
      <button type="button" data-close style="margin-top:8px;padding:10px 14px;border-radius:8px;border:none;background:#3b3b4a;color:#fff;cursor:pointer">Close</button>
    `
    body.querySelector('[data-close]')?.addEventListener('click', () => closeNftDialog())
    return false
  }

  const imgHtml = info.imageUrl
    ? `<img src="${escapeAttr(info.imageUrl)}" alt="" style="width:100%;max-height:280px;object-fit:contain;background:#0e0e14;display:block" referrerpolicy="no-referrer" />`
    : ''

  body.innerHTML = `
    ${imgHtml}
    <div style="font-weight:650;font-size:17px;line-height:1.3">${escapeHtml(info.name)}</div>
    ${info.owner ? `<div style="font-size:12px;opacity:0.65">Owner ${escapeHtml(shortAddr(info.owner))}</div>` : ''}
    ${info.description ? `<div style="font-size:13px;opacity:0.85;line-height:1.45;max-height:120px;overflow:auto">${escapeHtml(info.description)}</div>` : ''}
    <div style="display:flex;gap:8px;margin-top:6px;flex-wrap:wrap">
      <a data-opensea href="${escapeAttr(info.openseaUrl || openseaAssetPageUrl(info.parsed))}" target="_blank" rel="noopener noreferrer"
        style="flex:1;text-align:center;padding:10px 14px;border-radius:8px;background:#2081e2;color:#fff;text-decoration:none;font-weight:600;font-size:14px">View on OpenSea</a>
      <button type="button" data-close style="padding:10px 14px;border-radius:8px;border:1px solid rgba(255,255,255,0.15);background:transparent;color:#fff;cursor:pointer">Close</button>
    </div>
  `
  body.querySelector('[data-close]')?.addEventListener('click', () => closeNftDialog())
  return true
}

export function closeNftDialog(): void {
  const el = document.getElementById(OVERLAY_ID)
  if (!el) return
  const onKey = (el as unknown as { _onKey?: (e: KeyboardEvent) => void })._onKey
  if (onKey) document.removeEventListener('keydown', onKey)
  el.remove()
}

function shortAddr(addr: string): string {
  if (addr.length < 12) return addr
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/'/g, '&#39;')
}
