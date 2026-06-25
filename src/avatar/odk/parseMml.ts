export type MmlAttachmentTransform = {
  x: number
  y: number
  z: number
  rx: number
  ry: number
  rz: number
  sx: number
  sy: number
  sz: number
}

export type MmlAttachmentSpec = {
  src: string
  socket?: string
  transform: MmlAttachmentTransform
}

export type MmlCharacterSpec = {
  bodySrc: string
  animSrc?: string
  attachments: MmlAttachmentSpec[]
}

function parseFloatAttr(el: Element, name: string, fallback: number): number {
  const raw = el.getAttribute(name)
  if (raw == null || raw === '') return fallback
  const n = Number.parseFloat(raw)
  return Number.isFinite(n) ? n : fallback
}

function readTransform(el: Element): MmlAttachmentTransform {
  return {
    x: parseFloatAttr(el, 'x', 0),
    y: parseFloatAttr(el, 'y', 0),
    z: parseFloatAttr(el, 'z', 0),
    rx: parseFloatAttr(el, 'rx', 0),
    ry: parseFloatAttr(el, 'ry', 0),
    rz: parseFloatAttr(el, 'rz', 0),
    sx: parseFloatAttr(el, 'sx', 1),
    sy: parseFloatAttr(el, 'sy', 1),
    sz: parseFloatAttr(el, 'sz', 1)
  }
}

function resolveUrl(base: string | undefined, src: string): string {
  const trimmed = src.trim()
  if (!trimmed) throw new Error('MML: empty src')
  try {
    if (base) return new URL(trimmed, base).href
    return new URL(trimmed).href
  } catch {
    throw new Error(`MML: invalid src URL: ${trimmed}`)
  }
}

function parseAttachment(el: Element, baseUrl?: string): MmlAttachmentSpec | null {
  const tag = el.tagName.toLowerCase()
  if (tag !== 'm-model') return null
  const src = el.getAttribute('src')
  if (!src) return null
  return {
    src: resolveUrl(baseUrl, src),
    socket: el.getAttribute('socket')?.trim() || undefined,
    transform: readTransform(el)
  }
}

/** Parse MML document text into a character spec (`m-character` + child `m-model`). */
export function parseMmlCharacter(text: string, baseUrl?: string): MmlCharacterSpec {
  if (typeof DOMParser === 'undefined') {
    throw new Error('MML parsing requires DOMParser')
  }

  const doc = new DOMParser().parseFromString(text, 'text/html')
  const character =
    doc.querySelector('m-character') ??
    doc.querySelector('M-CHARACTER') ??
    doc.body?.querySelector('m-character')
  if (!character) {
    throw new Error('MML must contain an <m-character> element')
  }

  const bodySrc = character.getAttribute('src')
  if (!bodySrc) throw new Error('MML <m-character> requires a src attribute')

  const animSrc = character.getAttribute('anim')?.trim() || undefined
  const resolvedBase = baseUrl ?? (typeof window !== 'undefined' ? window.location.href : undefined)

  const attachments: MmlAttachmentSpec[] = []
  for (const child of character.children) {
    const att = parseAttachment(child, resolvedBase)
    if (att) attachments.push(att)
  }

  return {
    bodySrc: resolveUrl(resolvedBase, bodySrc),
    animSrc: animSrc ? resolveUrl(resolvedBase, animSrc) : undefined,
    attachments
  }
}

export async function fetchMmlText(url: string): Promise<{ text: string; baseUrl: string }> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`MML fetch failed (${res.status}): ${url}`)
  const text = await res.text()
  return { text, baseUrl: url }
}

export async function fetchUrlBytes(url: string): Promise<ArrayBuffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Fetch failed (${res.status}): ${url}`)
  const bytes = await res.arrayBuffer()
  if (bytes.byteLength <= 0) throw new Error(`Empty response: ${url}`)
  return bytes
}