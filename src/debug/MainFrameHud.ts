import type { PerfSnapshot } from '../util/perfCounters'
import { forceNoBloom, forceNoShadow, skipPhysxColliders, skipRemoteAvatars } from '../client/devFlags'

/**
 * Top-left main-thread frame pie — splits the former black-box "other" residual.
 * Opt-in: `?perf` / `?perfdebug` / `?framehud` (see wantMainFrameHud).
 *
 * Layout:
 *   FPS / Frame
 *   sync (rem / plat / player / sync+ children)
 *   render (main / tags)
 *   loop+ / apply / async~
 */
export class MainFrameHud {
  private el: HTMLDivElement | null = null
  private disposed = false
  private lastPaintAt = 0
  /** ~10 Hz paint — avoid DOM thrash on every rAF. */
  private static readonly PAINT_MS = 100

  private ensureEl(): HTMLDivElement | null {
    if (this.disposed) return null
    if (this.el) return this.el
    const el = document.createElement('div')
    el.id = 'main-frame-hud'
    el.setAttribute('aria-live', 'polite')
    // Top-left — stats.js / Debug panel live top-right when open.
    el.style.cssText = [
      'position:fixed',
      'top:10px',
      'left:10px',
      'z-index:10050',
      'pointer-events:none',
      'font:11px/1.35 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace',
      'color:#e8f0ff',
      'background:rgba(8,12,22,0.82)',
      'border:1px solid rgba(120,160,255,0.35)',
      'border-radius:8px',
      'padding:8px 10px',
      'min-width:176px',
      'backdrop-filter:blur(6px)',
      'box-shadow:0 4px 18px rgba(0,0,0,0.35)',
      'white-space:pre'
    ].join(';')
    el.textContent = 'frame…'
    document.body.appendChild(el)
    this.el = el
    return el
  }

  update(snap: PerfSnapshot): void {
    if (this.disposed) return
    const now = performance.now()
    if (now - this.lastPaintAt < MainFrameHud.PAINT_MS) return
    this.lastPaintAt = now
    const el = this.ensureEl()
    if (!el) return

    const fps = snap.fps > 0 ? snap.fps : snap.frameMs > 0 ? 1000 / snap.frameMs : 0
    const fpsColor = fps > 0 && fps < 28 ? '#ff6b6b' : fps < 45 ? '#f6c177' : '#7ddea2'
    const frameColor = snap.frameMs >= 33 ? '#f6c177' : '#e8f0ff'

    // part is nested under plat (pumpMotionBridges); show for visibility.
    const plusKnown =
      snap.envMs +
      snap.sceneTickMs +
      snap.peMs +
      snap.aoiMs +
      snap.petMs +
      snap.pointerMs
    const plusRest = Math.max(0, snap.syncRestMs - plusKnown)

    const abFlags = [
      skipPhysxColliders() ? 'nophysx' : '',
      skipRemoteAvatars() ? 'noremote' : '',
      forceNoBloom() ? 'nobloom' : '',
      forceNoShadow() ? 'noshadow' : ''
    ]
      .filter(Boolean)
      .join(' · ')
    const shadowLabel = snap.renderShadowOn ? 'shOn' : 'shOff'
    const trisM =
      snap.renderTriangles >= 1e6
        ? `${(snap.renderTriangles / 1e6).toFixed(2)}M`
        : snap.renderTriangles >= 1e3
          ? `${(snap.renderTriangles / 1e3).toFixed(0)}k`
          : String(snap.renderTriangles)
    el.innerHTML = [
      `<div style="font-weight:600;margin-bottom:3px">` +
        `<span style="color:${fpsColor}">FPS ${fmt1(fps)}</span>` +
        `  <span style="color:${frameColor}">Frame ${fmt1(snap.frameMs)}ms</span>` +
        `</div>`,
      abFlags
        ? `<div style="color:#f6c177;margin-bottom:2px">${abFlags}</div>`
        : '',
      section('sync', snap.syncMs, [
        ['rem', snap.remoteUpdateMs],
        ['plat', snap.platformMs],
        ['  part', snap.particleMs],
        ['player', snap.playerMs],
        ['sync+', snap.syncRestMs]
      ]),
      // Nested under sync+ — indent one more level
      nest([
        ['env', snap.envMs],
        ['scene', snap.sceneTickMs],
        ['pe', snap.peMs],
        ['aoi', snap.aoiMs],
        ['pet', snap.petMs],
        ['ptr', snap.pointerMs],
        ['+rest', plusRest]
      ]),
      section('render', snap.renderMs, [
        ['main', snap.renderMainMs],
        ['tags', snap.renderTagsMs]
      ]),
      // Nested under render.main
      nest([
        ['scene', snap.renderSceneMs],
        ['extract', snap.renderExtractMs],
        ['bloom', snap.renderBloomMs],
        ['blit', snap.renderBlitMs]
      ]),
      `<div style="padding-left:12px;opacity:.8;font-size:10px">` +
        `${escapeHtml(snap.renderMode)} · ${shadowLabel} · draws=${snap.renderDrawCalls} tris=${trisM}` +
        `</div>`,
      row('loop+', snap.loopRestMs, 'frame−sync−render'),
      row('apply', snap.applyMs, 'last CRDT (worker→main)'),
      `<div style="padding-left:12px;opacity:.85;font-size:10px">` +
        `loop send=${fmt1(snap.sceneLoopSendMs)} recv=${fmt1(snap.sceneLoopReceiveMs)} ` +
        `apply=${fmt1(snap.sceneLoopApplyMs)} ` +
        `g=${snap.sceneLoopGuests} due=${snap.sceneLoopDue} sent=${snap.sceneLoopSent} ` +
        `mute=${snap.sceneLoopMuteSent} inflight=${snap.sceneLoopInFlight}` +
        ` dt=${snap.sceneLoopLastSource ? formatGuestDt(snap.sceneLoopLastDt) : '-'}` +
        ` src=${snap.sceneLoopLastSource || '-'}` +
        `</div>`,
      section('async~', snap.asyncMs, [
        ['peel', snap.asyncPeelMs],
        ['coll', snap.asyncCollisionMs],
        ['bridge', snap.asyncBridgesMs],
        ['multi', snap.asyncMultiMs],
        ['ptr', snap.asyncPtrMs],
        ['+rest', snap.asyncRestMs]
      ]),
      // Nested under coll
      nest([
        ['syncC', snap.asyncCollSyncMs],
        ['pose', snap.asyncCollPoseMs],
        ['disc', snap.asyncCollDiscoverMs],
        ['cook', snap.asyncCollCookMs],
        ['watch', snap.asyncCollWatchMs],
        ['health', snap.asyncCollHealthMs],
        ['c+rest', snap.asyncCollRestMs]
      ]),
      `<div style="padding-left:20px;opacity:.75">cookQ=${snap.colliderCookQueueSize}</div>`,
      `<div style="margin-top:4px;opacity:.85">` +
        `peers ${snap.remotePeerTotal} pos=${snap.remoteVisible} ` +
        `shell=${snap.remotePlaceholder} body=${snap.remoteLoaded}` +
        `</div>`,
      `<div style="opacity:.8">` +
        `compose wait=${snap.remoteComposeWaiting} ` +
        `hold=${snap.remoteComposeHold} hyd=${snap.remoteComposeHydration} ` +
        `press=${snap.remoteComposePressure} gap=${snap.remoteComposeGapMs.toFixed(0)}ms` +
        `</div>`,
      `<div style="opacity:.5;margin-top:4px;font-size:10px;max-width:280px;white-space:normal">` +
        `render: scene=beauty(+shadow maps) · extract=sel · bloom=composite · ` +
        `fast folds post into scene · A/B ?noremote ?nobloom ?noshadow` +
        `</div>`
    ].join('')
  }

  dispose(): void {
    this.disposed = true
    this.el?.remove()
    this.el = null
  }
}

function section(
  label: string,
  totalMs: number,
  parts: Array<[string, number]>
): string {
  const head = row(label, totalMs)
  const kids = parts
    .map(
      ([k, v]) =>
        `<div style="padding-left:10px;display:flex;justify-content:space-between;gap:10px">` +
        `<span style="opacity:.6">${escapeHtml(k)}</span>` +
        `<span style="color:${msColor(v)}">${fmt1(v)}</span></div>`
    )
    .join('')
  return head + kids
}

function nest(parts: Array<[string, number]>): string {
  return parts
    .map(
      ([k, v]) =>
        `<div style="padding-left:20px;display:flex;justify-content:space-between;gap:10px">` +
        `<span style="opacity:.55">${escapeHtml(k)}</span>` +
        `<span style="color:${msColor(v)}">${fmt1(v)}</span></div>`
    )
    .join('')
}

function row(label: string, ms: number, hint = ''): string {
  const title = hint ? ` title="${escapeHtml(hint)}"` : ''
  return (
    `<div style="display:flex;justify-content:space-between;gap:12px"${title}>` +
    `<span style="opacity:.7">${escapeHtml(label)}</span>` +
    `<span style="color:${msColor(ms)}">${fmt1(ms)}ms</span></div>`
  )
}

function fmt1(n: number): string {
  if (!Number.isFinite(n)) return '0.0'
  return n.toFixed(1)
}

function formatGuestDt(dt: number): string {
  if (!(dt > 0)) return '0.000'
  const rounded = dt.toFixed(3)
  return rounded === '0.000' ? dt.toFixed(6) : rounded
}

function msColor(ms: number): string {
  if (ms >= 16) return '#ff6b6b'
  if (ms >= 8) return '#f6c177'
  return '#e8f0ff'
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
