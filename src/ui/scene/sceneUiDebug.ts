import type { Entity } from '@dcl/ecs'
import type { MirrorComponents } from '../../bridge/mirrorComponents'
import { canLocomote, readLocomotionFromComponents } from '../../player/locomotion'
import type { SceneUiDomRenderer } from './SceneUiDomRenderer'
import type { SceneUiHitMap } from './uiHitMap'
import type { LayoutBox } from './yogaLayout'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'

const TOLERANCE_PX = 2

type AuditRow = {
  entity: Entity
  hit: { left: number; top: number; width: number; height: number }
  dom: { left: number; top: number; width: number; height: number }
  delta: { left: number; top: number; width: number; height: number }
}

let lastStatusKey = ''
let lastInputModifierKey = ''
let overlayHost: HTMLElement | null = null

export function isSceneUiDebugEnabled(): boolean {
  return typeof location !== 'undefined' && location.search.includes('sceneuidebug')
}

function isDebugEnabled(): boolean {
  return isSceneUiDebugEnabled()
}

/** Compare hit-map screen rects vs DOM getBoundingClientRect for visible UiInput / UiDropdown fields. */
export function auditSceneUiAlignment(
  hitMap: SceneUiHitMap,
  dom: SceneUiDomRenderer,
  fieldEntities: Entity[]
): AuditRow[] {
  return visibleFieldAuditRows(hitMap, dom, fieldEntities).filter(
    (row) =>
      Math.abs(row.delta.left) > TOLERANCE_PX ||
      Math.abs(row.delta.top) > TOLERANCE_PX ||
      Math.abs(row.delta.width) > TOLERANCE_PX ||
      Math.abs(row.delta.height) > TOLERANCE_PX
  )
}

function ensureOverlay(): HTMLElement {
  if (overlayHost?.isConnected) return overlayHost
  overlayHost = document.createElement('div')
  overlayHost.id = 'scene-ui-debug-overlay'
  // Just above --z-scene-ui (40), below --z-client-hud (100)
  overlayHost.style.cssText =
    'position:fixed;inset:0;z-index:41;pointer-events:none;overflow:hidden;'
  document.body.appendChild(overlayHost)
  return overlayHost
}

function clearOverlay(): void {
  overlayHost?.replaceChildren()
}

function drawOverlay(rows: AuditRow[]): void {
  if (!isDebugEnabled()) return
  const host = ensureOverlay()
  host.replaceChildren()
  if (!rows.length) return
  for (const row of rows) {
    const hit = document.createElement('div')
    hit.style.cssText = `position:fixed;left:${row.hit.left}px;top:${row.hit.top}px;width:${row.hit.width}px;height:${row.hit.height}px;border:2px solid rgba(0,200,255,0.9);box-sizing:border-box;`
    host.appendChild(hit)

    const dom = document.createElement('div')
    dom.style.cssText = `position:fixed;left:${row.dom.left}px;top:${row.dom.top}px;width:${row.dom.width}px;height:${row.dom.height}px;border:2px dashed rgba(255,80,80,0.9);box-sizing:border-box;`
    host.appendChild(dom)
  }
}

function isVisibleDomRect(rect: DOMRect): boolean {
  return rect.width > 0.5 && rect.height > 0.5
}

/** Skip stale pooled nodes left after react-ecs conditional unmount. */
function visibleFieldAuditRows(
  hitMap: SceneUiHitMap,
  dom: SceneUiDomRenderer,
  fieldEntities: Entity[]
): AuditRow[] {
  const rows: AuditRow[] = []
  for (const entity of fieldEntities) {
    const field = dom.getFieldDom(entity)
    if (!field || !field.isConnected) continue
    const domRect = field.getBoundingClientRect()
    if (!isVisibleDomRect(domRect)) continue
    const region = hitMap.regionFor(entity)
    if (!region) continue
    rows.push({
      entity,
      hit: { left: region.left, top: region.top, width: region.width, height: region.height },
      dom: { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height },
      delta: {
        left: domRect.left - region.left,
        top: domRect.top - region.top,
        width: domRect.width - region.width,
        height: domRect.height - region.height
      }
    })
  }
  return rows
}

type ScrimCandidate = { entity: number; alpha: number; w: number; h: number }

function listVisibleScrimCandidates(root: ParentNode): ScrimCandidate[] {
  const out: ScrimCandidate[] = []
  for (const el of root.querySelectorAll('.scene-ui-node[data-entity]')) {
    if (!(el instanceof HTMLElement)) continue
    const style = window.getComputedStyle(el)
    if (style.display === 'none' || style.visibility === 'hidden') continue
    if (parseFloat(style.opacity) < 0.05) continue
    const rect = el.getBoundingClientRect()
    if (rect.width < window.innerWidth * 0.5 || rect.height < window.innerHeight * 0.5) continue
    const bgEl = el.querySelector('.scene-ui-node__bg') as HTMLElement | null
    const bgStyle = bgEl ? window.getComputedStyle(bgEl) : style
    const bg = parseFloat(bgStyle.backgroundColor.split(',')[3] ?? '1') || 0
    const hasBgLayer = bgEl !== null
    if (!hasBgLayer && bg < 0.05) continue
    const id = Number(el.dataset.entity)
    if (!Number.isFinite(id)) continue
    out.push({
      entity: id,
      alpha: bg,
      w: Math.round(rect.width),
      h: Math.round(rect.height)
    })
  }
  return out
}

export function reportSceneUiDebug(input: {
  hitMap: SceneUiHitMap
  dom: SceneUiDomRenderer
  fieldEntities: Entity[]
  uiInputCount: number
  domInputCount: number
  layoutCacheHit: boolean
  workerUiEntityCount?: number
  layoutBoxes?: ReadonlyMap<Entity, LayoutBox>
  transformOf?: (entity: Entity) => PBUiTransform | null
  virtual?: { width: number; height: number }
}): void {
  if (!isDebugEnabled()) return

  const visibleRows = visibleFieldAuditRows(input.hitMap, input.dom, input.fieldEntities)
  const mismatches = visibleRows.filter(
    (row) =>
      Math.abs(row.delta.left) > TOLERANCE_PX ||
      Math.abs(row.delta.top) > TOLERANCE_PX ||
      Math.abs(row.delta.width) > TOLERANCE_PX ||
      Math.abs(row.delta.height) > TOLERANCE_PX
  )
  const pooled = input.dom.getPooledNodeCount()
  const connected = input.dom.countConnectedDomNodes()
  const interactiveDom = input.dom.countInteractiveDomNodes()
  const scrimRoot = document.querySelector('#scene-ui-root') ?? document.body
  const scrimList = listVisibleScrimCandidates(scrimRoot)
  const scrimCandidates = scrimList.filter(
    (s) => s.w >= window.innerWidth * 0.85 && s.h >= window.innerHeight * 0.85
  ).length
  let orphanDom = 0
  for (const el of scrimRoot.querySelectorAll('.scene-ui-node[data-entity]')) {
    if (!(el instanceof HTMLElement)) continue
    const id = Number(el.dataset.entity)
    if (!Number.isFinite(id)) {
      orphanDom++
      continue
    }
    if (!el.isConnected) orphanDom++
  }
  const workerCount = input.workerUiEntityCount ?? -1
  const visibleYoga = input.layoutBoxes?.size ?? 0
  let unusableDom = 0
  for (const el of scrimRoot.querySelectorAll('.scene-ui-node[data-ui-unusable="1"]')) {
    if (el instanceof HTMLElement) unusableDom++
  }
  const statusKey = `${input.uiInputCount}|${input.domInputCount}|${input.layoutCacheHit}|${workerCount}|${pooled}|${connected}|${interactiveDom}|${visibleYoga}|${unusableDom}|${scrimCandidates}|${orphanDom}|${scrimList.map((s) => s.entity).join(',')}|${visibleRows.map((m) => `${m.entity}:${m.dom.left},${m.dom.top}`).join(';')}`
  if (statusKey === lastStatusKey) return
  lastStatusKey = statusKey

  console.log(
    `[scene-ui] UiInput=${input.uiInputCount} domInputs=${input.domInputCount} workerUi=${workerCount} ` +
      `pooled=${pooled} connected=${connected} interactiveDom=${interactiveDom} ` +
      `visibleYoga=${visibleYoga} unusableDom=${unusableDom} fullscreenScrims=${scrimCandidates} ` +
      `orphanDom=${orphanDom} layout=yoga cacheHit=${input.layoutCacheHit}`
  )
  const domRects: string[] = []
  for (const el of scrimRoot.querySelectorAll('.scene-ui-node[data-entity]')) {
    if (!(el instanceof HTMLElement)) continue
    const style = window.getComputedStyle(el)
    if (style.display === 'none') continue
    const rect = el.getBoundingClientRect()
    domRects.push(
      `e${el.dataset.entity} ${Math.round(rect.width)}×${Math.round(rect.height)}@${Math.round(rect.left)},${Math.round(rect.top)} z=${style.zIndex} op=${style.opacity}`
    )
  }
  if (domRects.length) {
    console.log(`[scene-ui] dom rects: ${domRects.join(' · ')}`)
  } else if (connected > 0) {
    console.warn('[scene-ui] connected DOM nodes but no visible rects — check yoga boxes / display:none')
  }
  if (interactiveDom === 0 && connected > 0) {
    console.warn(
      `[scene-ui] no interactive DOM nodes — clicks pass through to canvas (PointerEvents missing in projection?)`
    )
  }
  if (input.layoutBoxes && input.transformOf && input.layoutBoxes.size > 0) {
    const virtual = input.virtual ?? { width: 0, height: 0 }
    const yogaRows: string[] = []
    const parentRows: string[] = []
    for (const [entity, box] of [...input.layoutBoxes.entries()].sort(
      (a, b) => (a[0] as number) - (b[0] as number)
    )) {
      const t = input.transformOf(entity)
      yogaRows.push(
        `e${entity} abs=${Math.round(box.left)},${Math.round(box.top)} rel=${Math.round(box.relLeft)},${Math.round(box.relTop)} ${Math.round(box.width)}×${Math.round(box.height)}`
      )
      parentRows.push(`e${entity} parent=e${t?.parent ?? 0} pos=${t?.positionType ?? 0} j=${t?.justifyContent ?? 0} fd=${t?.flexDirection ?? 0}`)
    }
    console.log(`[scene-ui] yoga @${virtual.width}×${virtual.height}: ${yogaRows.join(' · ')}`)
    console.log(`[scene-ui] transforms: ${parentRows.join(' · ')}`)
  }
  if (scrimList.length > 0) {
    console.log(
      `[scene-ui] scrim layers (${scrimList.length}):`,
      scrimList.map((s) => `e${s.entity} α=${s.alpha.toFixed(2)} ${s.w}×${s.h}`).join(', ')
    )
  }
  if (connected > pooled || scrimCandidates > 1 || scrimList.length > 2) {
    console.warn(
      `[scene-ui] ghost risk — connected=${connected} pooled=${pooled} workerUi=${workerCount} fullscreenScrims=${scrimCandidates} semiScrims=${scrimList.length}`
    )
  }

  if (!visibleRows.length) {
    clearOverlay()
    return
  }

  if (mismatches.length > 0) {
    console.warn('[scene-ui] hit map ≠ DOM (cyan=hit, red=DOM):', mismatches)
    drawOverlay(mismatches)
    return
  }

  drawOverlay(visibleRows)
}

/** Log scene InputModifier on PlayerEntity — explains avatar locomotion gating with ?sceneuidebug. */
export function reportInputModifierState(ecs: MirrorComponents, player: Entity): void {
  if (!isDebugEnabled()) return
  const has = ecs.InputModifier.has(player)
  const mod = has ? ecs.InputModifier.getOrNull(player) : null
  const std = mod?.mode?.$case === 'standard' ? mod.mode.standard : null
  const key = JSON.stringify({ has, std })
  if (key === lastInputModifierKey) return
  lastInputModifierKey = key
  const locomotion = readLocomotionFromComponents(ecs, player)
  console.log(
    `[scene-ui] InputModifier player=e${player} has=${has} disableAll=${locomotion.disableAll} locomotion=${canLocomote(locomotion) ? 'allowed' : 'blocked'}`
  )
}

export function disposeSceneUiDebug(): void {
  overlayHost?.remove()
  overlayHost = null
  lastStatusKey = ''
  lastInputModifierKey = ''
}