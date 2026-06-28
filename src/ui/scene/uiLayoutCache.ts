import type { Entity } from '@dcl/ecs'
import type { PBUiInput } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_input.gen'
import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'
import type { PBUiTransform } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_transform.gen'
import type { LayoutBox } from './yogaLayout'
import { isUiEntityVisible } from './uiVisibility'
import type { UiEntityRecord } from './uiTree'
import type { VirtualCanvasSize } from './virtualCanvas'

/** Transform fields that do not affect Yoga sizing (filtered before cache key). */
const LAYOUT_STRIP_KEYS = new Set(['opacity', 'zIndex', 'pointerFilter'])

function layoutTransformFingerprint(transform: PBUiTransform): string {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(transform)) {
    if (LAYOUT_STRIP_KEYS.has(key)) continue
    if (value === undefined) continue
    out[key] = value
  }
  return JSON.stringify(out)
}

function layoutTextFingerprint(entity: Entity, text: PBUiText | null): string {
  if (!text?.value?.trim()) return ''
  return `T${entity}:${text.value}:${text.fontSize ?? 10}:${text.font ?? 0}`
}

/**
 * Fingerprint of everything that affects Yoga `calculateLayout`.
 * Excludes opacity/zIndex/pointerFilter — those are applied when filtering visible boxes.
 */
function layoutInputFingerprint(entity: Entity, input: PBUiInput | null): string {
  if (!input) return ''
  return `I${entity}:${input.fontSize ?? 10}:${input.disabled ? 1 : 0}`
}

export function computeUiLayoutKey(
  records: UiEntityRecord[],
  virtual: VirtualCanvasSize,
  textOf: (e: Entity) => PBUiText | null,
  inputOf?: (e: Entity) => PBUiInput | null
): string {
  if (records.length === 0) return ''
  const parts: string[] = [`V${virtual.width}x${virtual.height}`, `N${records.length}`]
  const sorted = [...records].sort((a, b) => (a.entity as number) - (b.entity as number))
  for (const { entity, transform } of sorted) {
    parts.push(`${entity}:${layoutTransformFingerprint(transform)}`)
    const textKey = layoutTextFingerprint(entity, textOf(entity))
    if (textKey) parts.push(textKey)
    if (inputOf) {
      const inputKey = layoutInputFingerprint(entity, inputOf(entity))
      if (inputKey) parts.push(inputKey)
    }
  }
  return parts.join('\n')
}

/** Drop entities hidden by display:none / opacity along the ancestor chain. */
export function visibleLayoutBoxes(
  boxes: LayoutBox[],
  transformOf: (e: Entity) => PBUiTransform | null
): LayoutBox[] {
  return boxes.filter((box) => isUiEntityVisible(box.entity, transformOf))
}

export class UiLayoutCache {
  private key = ''
  private boxes: LayoutBox[] | null = null

  get(key: string): LayoutBox[] | null {
    if (!this.boxes || key !== this.key) return null
    return this.boxes
  }

  set(key: string, boxes: LayoutBox[]): void {
    this.key = key
    this.boxes = boxes
  }

  clear(): void {
    this.key = ''
    this.boxes = null
  }
}