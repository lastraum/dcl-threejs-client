import type { PBUiText } from '@dcl/ecs/dist/components/generated/pb/decentraland/sdk/components/ui_text.gen'

const FONT_FAMILY: Record<number, string> = {
  0: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  1: 'Georgia, "Times New Roman", serif',
  2: 'ui-monospace, "Cascadia Code", "SF Mono", Consolas, monospace'
}

let measureCanvas: HTMLCanvasElement | null = null
let measureCtx: CanvasRenderingContext2D | null = null

function measureContext(): CanvasRenderingContext2D | null {
  if (typeof document === 'undefined') return null
  if (!measureCanvas) {
    measureCanvas = document.createElement('canvas')
    measureCtx = measureCanvas.getContext('2d')
  }
  return measureCtx
}

function stripUiTextMarkup(value: string): string {
  return value.replace(/<\/?[bi]>/gi, '')
}

/** Canvas-based intrinsic text box (virtual canvas px) for Yoga + DOM sizing. */
export function measureUiText(
  text: PBUiText,
  scale = 1
): { width: number; height: number } {
  const raw = text.value?.trim() ?? ''
  if (!raw) return { width: 0, height: 0 }

  const fontPx = Math.max(1, (text.fontSize ?? 10) * scale)
  const family = FONT_FAMILY[text.font ?? 0] ?? FONT_FAMILY[0]
  const lineHeight = fontPx * 1.25
  const padX = 8 * scale
  const padY = 4 * scale
  const plain = stripUiTextMarkup(raw)
  const lines = plain.split('\n')

  const ctx = measureContext()
  if (ctx) {
    ctx.font = `${fontPx}px ${family}`
    let width = 0
    for (const line of lines) {
      width = Math.max(width, ctx.measureText(line).width)
    }
    const height = lineHeight * Math.max(1, lines.length)
    return {
      width: Math.ceil(width + padX),
      height: Math.ceil(height + padY)
    }
  }

  const approxChar = fontPx * 0.55
  const longest = lines.reduce((m, l) => Math.max(m, l.length), 0)
  return {
    width: Math.ceil(longest * approxChar + padX),
    height: Math.ceil(lineHeight * Math.max(1, lines.length) + padY)
  }
}