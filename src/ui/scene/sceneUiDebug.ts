import type { Entity } from '@dcl/ecs'
import type { SceneUiDomRenderer } from './SceneUiDomRenderer'
import type { SceneUiHitMap } from './uiHitMap'

const TOLERANCE_PX = 2

type AuditRow = {
  entity: Entity
  hit: { left: number; top: number; width: number; height: number }
  dom: { left: number; top: number; width: number; height: number }
  delta: { left: number; top: number; width: number; height: number }
}

let lastStatusKey = ''
let overlayHost: HTMLElement | null = null

function isDebugEnabled(): boolean {
  return typeof location !== 'undefined' && location.search.includes('sceneuidebug')
}

/** Compare hit-map screen rects vs DOM getBoundingClientRect for form fields. */
export function auditSceneUiAlignment(
  hitMap: SceneUiHitMap,
  dom: SceneUiDomRenderer,
  formEntities: Entity[]
): AuditRow[] {
  const mismatches: AuditRow[] = []
  for (const entity of formEntities) {
    const field = dom.getFormField(entity)
    if (!field) continue
    const domRect = field.getBoundingClientRect()
    const region = hitMap.regionFor(entity)
    if (!region) {
      mismatches.push({
        entity,
        hit: { left: 0, top: 0, width: 0, height: 0 },
        dom: { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height },
        delta: { left: NaN, top: NaN, width: NaN, height: NaN }
      })
      continue
    }
    const hit = { left: region.left, top: region.top, width: region.width, height: region.height }
    const delta = {
      left: domRect.left - hit.left,
      top: domRect.top - hit.top,
      width: domRect.width - hit.width,
      height: domRect.height - hit.height
    }
    if (
      Math.abs(delta.left) > TOLERANCE_PX ||
      Math.abs(delta.top) > TOLERANCE_PX ||
      Math.abs(delta.width) > TOLERANCE_PX ||
      Math.abs(delta.height) > TOLERANCE_PX
    ) {
      mismatches.push({ entity, hit, dom: { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height }, delta })
    }
  }
  return mismatches
}

function ensureOverlay(): HTMLElement {
  if (overlayHost?.isConnected) return overlayHost
  overlayHost = document.createElement('div')
  overlayHost.id = 'scene-ui-debug-overlay'
  overlayHost.style.cssText =
    'position:fixed;inset:0;z-index:41;pointer-events:none;overflow:hidden;'
  document.body.appendChild(overlayHost)
  return overlayHost
}

function drawOverlay(rows: AuditRow[]): void {
  if (!isDebugEnabled()) return
  const host = ensureOverlay()
  host.replaceChildren()
  for (const row of rows) {
    const hit = document.createElement('div')
    hit.style.cssText = `position:fixed;left:${row.hit.left}px;top:${row.hit.top}px;width:${row.hit.width}px;height:${row.hit.height}px;border:2px solid rgba(0,200,255,0.9);box-sizing:border-box;`
    host.appendChild(hit)

    const dom = document.createElement('div')
    dom.style.cssText = `position:fixed;left:${row.dom.left}px;top:${row.dom.top}px;width:${row.dom.width}px;height:${row.dom.height}px;border:2px dashed rgba(255,80,80,0.9);box-sizing:border-box;`
    host.appendChild(dom)
  }
}

export function reportSceneUiDebug(input: {
  hitMap: SceneUiHitMap
  dom: SceneUiDomRenderer
  formEntities: Entity[]
  uiInputCount: number
  domInputCount: number
  layoutCacheHit: boolean
}): void {
  if (!isDebugEnabled()) return

  const mismatches = auditSceneUiAlignment(input.hitMap, input.dom, input.formEntities)
  const statusKey = `${input.uiInputCount}|${input.domInputCount}|${input.layoutCacheHit}|${mismatches.map((m) => `${m.entity}:${m.delta.left},${m.delta.top}`).join(';')}`
  if (statusKey === lastStatusKey) return
  lastStatusKey = statusKey

  console.log(
    `[scene-ui] UiInput=${input.uiInputCount} domInputs=${input.domInputCount} layoutCache=${input.layoutCacheHit ? 'hit' : 'miss'}`
  )

  if (mismatches.length > 0) {
    console.warn('[scene-ui] hit map ≠ DOM (cyan=hit, red=DOM):', mismatches)
    drawOverlay(mismatches)
    return
  }

  if (input.formEntities.length > 0) {
    const rows = input.formEntities
      .map((entity): AuditRow | null => {
        const region = input.hitMap.regionFor(entity)
        const field = input.dom.getFormField(entity)
        if (!region || !field) return null
        const domRect = field.getBoundingClientRect()
        return {
          entity,
          hit: { left: region.left, top: region.top, width: region.width, height: region.height },
          dom: { left: domRect.left, top: domRect.top, width: domRect.width, height: domRect.height },
          delta: { left: 0, top: 0, width: 0, height: 0 }
        }
      })
      .filter((r): r is AuditRow => r !== null)
    drawOverlay(rows)
  }
}

export function disposeSceneUiDebug(): void {
  overlayHost?.remove()
  overlayHost = null
  lastStatusKey = ''
}