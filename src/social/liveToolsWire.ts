/**
 * Live tools (polls + Q&A) over scene LiveKit data topics.
 *
 * - Topic: `d3js-live-tools:{placeKey}` (never bare / never RFC4 Chat → does not hit scene chat)
 * - Payload: magic `D3LT` + JSON (same pattern as poolClaimWire / communityFollowWire)
 */

/** LiveKit data topic prefix for live tools. */
export const LIVE_TOOLS_TOPIC_PREFIX = 'd3js-live-tools:'

/** Binary payload magic: ASCII "D3LT" */
export const LIVE_TOOLS_DATA_MAGIC = new Uint8Array([0x44, 0x33, 0x4c, 0x54])

export const LIVE_TOOLS_QA_TEXT_MAX = 280
export const LIVE_TOOLS_POLL_OPTIONS_MIN = 2
export const LIVE_TOOLS_POLL_OPTIONS_MAX = 6
export const LIVE_TOOLS_QUESTION_MAX = 200

export type LivePollState = {
  id: string
  question: string
  options: string[]
  /** optionIndex → count (owner-authoritative after votes). */
  counts: number[]
  /** Lowercased wallets that already voted (owner tracks; optional on peers). */
  voters?: string[]
  open: boolean
  at: number
}

export type LiveQaItem = {
  id: string
  text: string
  from: string
  name?: string
  at: number
  dismissed?: boolean
}

export type LiveProjectedQuestion = {
  id: string
  text: string
  from?: string
  name?: string
} | null

export type LiveToolsWireMsg =
  | {
      t: 'poll_open'
      id: string
      q: string
      opts: string[]
      at: number
    }
  | {
      t: 'poll_vote'
      id: string
      i: number
      a: string
    }
  | {
      t: 'poll_close'
      id: string
      counts: number[]
      at: number
    }
  | {
      t: 'poll_sync'
      poll: LivePollState | null
      at: number
    }
  | {
      t: 'qa_ask'
      id: string
      text: string
      a: string
      n?: string
      at: number
    }
  | {
      t: 'qa_project'
      id: string | null
      text?: string
      a?: string
      n?: string
      at: number
    }
  | {
      t: 'qa_dismiss'
      id: string
      at: number
    }
  | {
      t: 'session_hello'
      at: number
    }
  | {
      t: 'session_sync'
      poll: LivePollState | null
      projected: LiveProjectedQuestion
      /** Owner may include recent non-dismissed Qs for host rejoin — peers ignore if not host. */
      qa?: LiveQaItem[]
      at: number
    }

export function liveToolsTopic(placeKey: string): string {
  return `${LIVE_TOOLS_TOPIC_PREFIX}${placeKey.trim().toLowerCase()}`
}

export function parseLiveToolsTopic(topic: string | undefined | null): string | null {
  const t = topic?.trim() ?? ''
  if (!t.toLowerCase().startsWith(LIVE_TOOLS_TOPIC_PREFIX)) return null
  const key = t.slice(LIVE_TOOLS_TOPIC_PREFIX.length).trim().toLowerCase()
  return key || null
}

export function isLiveToolsTopic(topic: string | undefined | null): boolean {
  return parseLiveToolsTopic(topic) != null
}

export function encodeLiveToolsDataPacket(msg: LiveToolsWireMsg): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(msg))
  const out = new Uint8Array(LIVE_TOOLS_DATA_MAGIC.length + json.length)
  out.set(LIVE_TOOLS_DATA_MAGIC, 0)
  out.set(json, LIVE_TOOLS_DATA_MAGIC.length)
  return out
}

export function tryParseLiveToolsDataPacket(data: Uint8Array): LiveToolsWireMsg | null {
  if (data.length < LIVE_TOOLS_DATA_MAGIC.length + 2) return null
  for (let i = 0; i < LIVE_TOOLS_DATA_MAGIC.length; i++) {
    if (data[i] !== LIVE_TOOLS_DATA_MAGIC[i]) return null
  }
  try {
    const json = new TextDecoder().decode(data.subarray(LIVE_TOOLS_DATA_MAGIC.length))
    return parseLiveToolsObject(JSON.parse(json) as Record<string, unknown>)
  } catch {
    return null
  }
}

export function placeKeyFromScene(scene: {
  source: { kind: string }
  baseParcel?: string
  commsPointer?: string
}): string {
  if (scene.source.kind === 'world') {
    return (scene.commsPointer ?? '').trim().toLowerCase() || 'world'
  }
  return (scene.baseParcel ?? '0,0').trim().toLowerCase()
}

export function isLiveToolsHost(wallet: string | null | undefined, ownerAddresses: string[]): boolean {
  const w = wallet?.trim().toLowerCase() ?? ''
  if (!w || !/^0x[a-f0-9]{40}$/.test(w)) return false
  return ownerAddresses.some((o) => o.trim().toLowerCase() === w)
}

function asString(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function asNumber(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}

function parsePollState(o: unknown): LivePollState | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const id = asString(r.id)?.trim()
  const question = asString(r.question)?.trim()
  if (!id || !question) return null
  const options = Array.isArray(r.options)
    ? r.options.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
    : []
  if (options.length < LIVE_TOOLS_POLL_OPTIONS_MIN) return null
  const counts = Array.isArray(r.counts)
    ? r.counts.map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0))
    : options.map(() => 0)
  while (counts.length < options.length) counts.push(0)
  const voters = Array.isArray(r.voters)
    ? r.voters
        .filter((x): x is string => typeof x === 'string')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => /^0x[a-f0-9]{40}$/.test(s))
    : undefined
  return {
    id,
    question: question.slice(0, LIVE_TOOLS_QUESTION_MAX),
    options: options.slice(0, LIVE_TOOLS_POLL_OPTIONS_MAX).map((s) => s.slice(0, 80)),
    counts: counts.slice(0, options.length),
    voters,
    open: r.open !== false,
    at: asNumber(r.at) ?? Date.now()
  }
}

function parseProjected(o: unknown): LiveProjectedQuestion {
  if (o == null) return null
  if (typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const id = asString(r.id)?.trim()
  const text = asString(r.text)?.trim()
  if (!id || !text) return null
  return {
    id,
    text: text.slice(0, LIVE_TOOLS_QA_TEXT_MAX),
    from: asString(r.from)?.trim().toLowerCase() || undefined,
    name: asString(r.name)?.trim() || undefined
  }
}

function parseQaItem(o: unknown): LiveQaItem | null {
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  const id = asString(r.id)?.trim()
  const text = asString(r.text)?.trim()
  const from = asString(r.from)?.trim().toLowerCase()
  if (!id || !text || !from) return null
  return {
    id,
    text: text.slice(0, LIVE_TOOLS_QA_TEXT_MAX),
    from,
    name: asString(r.name)?.trim() || undefined,
    at: asNumber(r.at) ?? Date.now(),
    dismissed: r.dismissed === true
  }
}

function parseLiveToolsObject(o: Record<string, unknown>): LiveToolsWireMsg | null {
  const t = asString(o.t)
  if (!t) return null
  const at = asNumber(o.at) ?? Date.now()

  switch (t) {
    case 'poll_open': {
      const id = asString(o.id)?.trim()
      const q = asString(o.q)?.trim()
      const opts = Array.isArray(o.opts)
        ? o.opts.filter((x): x is string => typeof x === 'string').map((s) => s.trim()).filter(Boolean)
        : []
      if (!id || !q || opts.length < LIVE_TOOLS_POLL_OPTIONS_MIN) return null
      return {
        t: 'poll_open',
        id,
        q: q.slice(0, LIVE_TOOLS_QUESTION_MAX),
        opts: opts.slice(0, LIVE_TOOLS_POLL_OPTIONS_MAX).map((s) => s.slice(0, 80)),
        at
      }
    }
    case 'poll_vote': {
      const id = asString(o.id)?.trim()
      const a = asString(o.a)?.trim().toLowerCase()
      const i = asNumber(o.i)
      if (!id || !a || i == null || i < 0) return null
      return { t: 'poll_vote', id, i: Math.floor(i), a }
    }
    case 'poll_close': {
      const id = asString(o.id)?.trim()
      if (!id) return null
      const counts = Array.isArray(o.counts)
        ? o.counts.map((n) => (typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0))
        : []
      return { t: 'poll_close', id, counts, at }
    }
    case 'poll_sync': {
      const poll = o.poll == null ? null : parsePollState(o.poll)
      return { t: 'poll_sync', poll, at }
    }
    case 'qa_ask': {
      const id = asString(o.id)?.trim()
      const text = asString(o.text)?.trim()
      const a = asString(o.a)?.trim().toLowerCase()
      if (!id || !text || !a) return null
      return {
        t: 'qa_ask',
        id,
        text: text.slice(0, LIVE_TOOLS_QA_TEXT_MAX),
        a,
        n: asString(o.n)?.trim() || undefined,
        at
      }
    }
    case 'qa_project': {
      const idRaw = o.id
      const id = idRaw === null ? null : asString(idRaw)?.trim() ?? null
      if (id === null) return { t: 'qa_project', id: null, at }
      const text = asString(o.text)?.trim()
      if (!id || !text) return null
      return {
        t: 'qa_project',
        id,
        text: text.slice(0, LIVE_TOOLS_QA_TEXT_MAX),
        a: asString(o.a)?.trim().toLowerCase() || undefined,
        n: asString(o.n)?.trim() || undefined,
        at
      }
    }
    case 'qa_dismiss': {
      const id = asString(o.id)?.trim()
      if (!id) return null
      return { t: 'qa_dismiss', id, at }
    }
    case 'session_hello':
      return { t: 'session_hello', at }
    case 'session_sync': {
      const poll = o.poll == null ? null : parsePollState(o.poll)
      const projected = parseProjected(o.projected)
      const qa = Array.isArray(o.qa)
        ? o.qa.map(parseQaItem).filter((x): x is LiveQaItem => x != null).slice(0, 50)
        : undefined
      return { t: 'session_sync', poll, projected, qa, at }
    }
    default:
      return null
  }
}

export function newLiveToolsId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `lt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
