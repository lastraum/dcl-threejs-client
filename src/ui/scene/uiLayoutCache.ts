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

/** Yoga-relevant transform fingerprint — excludes paint-only opacity/zIndex/pointerFilter. */
export function layoutTransformFingerprint(transform: PBUiTransform): string {
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

/**
 * Per-entity paint fingerprint for fields that change DOM without Yoga geometry
 * (opacity, colors, PE, textures). Used for skip-paint + dirty DOM patch.
 */
export function entityUiVisualPaintKey(
  entity: Entity,
  transform: PBUiTransform,
  text: PBUiText | null,
  bg: {
    color?: { r?: number; g?: number; b?: number; a?: number }
    texture?: unknown
    uvs?: number[]
    textureMode?: number | string
  } | null,
  pointerKey: string
): string {
  const o = transform.opacity ?? 1
  const z = transform.zIndex ?? 0
  const pf = transform.pointerFilter ?? 0
  const d = transform.display ?? 0
  let t = ''
  if (text?.value != null) {
    t = `t${text.value.length}:${text.value.slice(0, 48)}:${text.fontSize ?? 10}:${text.textWrap ?? 0}:${text.color?.r ?? 1},${text.color?.g ?? 1},${text.color?.b ?? 1},${text.color?.a ?? 1}`
  }
  let b = ''
  if (bg) {
    const c = bg.color
    b = c ? `bg${c.r ?? 0},${c.g ?? 0},${c.b ?? 0},${c.a ?? 1}` : 'bg'
    if (bg.texture) b += ':tex'
    if (bg.textureMode != null) b += `:tm${bg.textureMode}`
    // Atlas sprite rect + animated fill/zone UVs (fishing reeling bars update every tick).
    // Support number[], TypedArray, and post-JSON `{0:u0,…}` object form (no .length).
    if (bg.uvs != null) {
      const u = bg.uvs as ArrayLike<number> | Record<string, number>
      let n = (u as { length?: number }).length ?? 0
      if (!n && typeof u === 'object' && !Array.isArray(u) && !ArrayBuffer.isView(u)) {
        while (Object.prototype.hasOwnProperty.call(u, String(n))) n++
      }
      if (n >= 8) {
        const parts: string[] = []
        const at = (i: number) =>
          Array.isArray(u) || ArrayBuffer.isView(u)
            ? Number((u as ArrayLike<number>)[i])
            : Number((u as Record<string, number>)[String(i)])
        for (let i = 0; i < 8; i++) parts.push(at(i).toFixed(4))
        b += `:uv${parts.join(',')}`
      }
    }
  }
  return `${entity}|d${d}|o${o}|z${z}|pf${pf}|${t}|${b}|pe${pointerKey}`
}

export function computeUiVisualPaintKey(
  records: UiEntityRecord[],
  textOf: (e: Entity) => PBUiText | null,
  backgroundOf: (
    e: Entity
  ) => {
    color?: { r?: number; g?: number; b?: number; a?: number }
    texture?: unknown
    uvs?: number[]
    textureMode?: number | string
  } | null,
  pointerKeyOf: (e: Entity) => string
): { full: string; byEntity: Map<Entity, string> } {
  const byEntity = new Map<Entity, string>()
  const parts: string[] = []
  const sorted = [...records].sort((a, b) => (a.entity as number) - (b.entity as number))
  for (const { entity, transform } of sorted) {
    const key = entityUiVisualPaintKey(
      entity,
      transform,
      textOf(entity),
      backgroundOf(entity),
      pointerKeyOf(entity)
    )
    byEntity.set(entity, key)
    parts.push(key)
  }
  return { full: parts.join('\n'), byEntity }
}

/** Drop entities hidden by display:none / opacity along the ancestor chain. */
export function visibleLayoutBoxes(
  boxes: LayoutBox[],
  transformOf: (e: Entity) => PBUiTransform | null
): LayoutBox[] {
  return boxes.filter((box) => isUiEntityVisible(box.entity, transformOf))
}

/**
 * Visible mounted entities that lack a Yoga box — paint would force-hide their subtrees
 * ("yoga box unusable … none"). Callers must re-run full layoutUiTree when this is non-empty
 * (typical: shop open after display:none while last boxes only tracked the HUD chrome).
 */
export function missingVisibleLayoutEntities(
  mounted: ReadonlySet<Entity>,
  transformOf: (e: Entity) => PBUiTransform | null,
  boxes: ReadonlyMap<Entity, LayoutBox>
): Entity[] {
  const missing: Entity[] = []
  for (const entity of mounted) {
    if (!isUiEntityVisible(entity, transformOf)) continue
    if (!boxes.has(entity)) missing.push(entity)
  }
  return missing
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