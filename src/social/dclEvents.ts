/**
 * Decentraland Events API — https://docs.decentraland.org/apis/apis/events/events
 * Base: https://events.decentraland.org/api
 */

const EVENTS_LIST_URL = 'https://events.decentraland.org/api/events'

export type DclEventListFilter = 'all' | 'active' | 'live' | 'upcoming'

export type DclEventWorldFilter = 'all' | 'genesis' | 'worlds'

export type DclEvent = {
  id: string
  name: string
  image: string | null
  image_vertical?: string | null
  description?: string | null
  start_at: string
  next_start_at?: string | null
  finish_at?: string | null
  next_finish_at?: string | null
  duration?: number
  live?: boolean
  world?: boolean
  x?: number
  y?: number
  coordinates?: number[]
  url?: string
  user_name?: string | null
  total_attendees?: number
}

export function eventPosterSrc(e: DclEvent): string | null {
  const v = e.image_vertical?.trim()
  if (v) return v
  const h = e.image?.trim()
  return h || null
}

export function eventHeroImageSrc(e: DclEvent): string | null {
  const h = e.image?.trim()
  if (h) return h
  return eventPosterSrc(e)
}

export function eventOccurrenceStartMs(e: DclEvent): number {
  const raw = e.next_start_at?.trim() || e.start_at
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : NaN
}

export function eventOccurrenceEndMs(e: DclEvent): number {
  const fromApi = e.next_finish_at?.trim() || e.finish_at?.trim()
  if (fromApi) {
    const t = Date.parse(fromApi)
    if (Number.isFinite(t)) return t
  }
  const start = eventOccurrenceStartMs(e)
  const d = typeof e.duration === 'number' && e.duration > 0 ? e.duration : NaN
  if (Number.isFinite(start) && Number.isFinite(d)) return start + d
  return NaN
}

export function isEventLiveNow(e: DclEvent, nowMs: number = Date.now()): boolean {
  const start = eventOccurrenceStartMs(e)
  const end = eventOccurrenceEndMs(e)
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false
  return start <= nowMs && nowMs < end
}

export function eventSortTimeMs(e: DclEvent): number {
  const t = eventOccurrenceStartMs(e)
  return Number.isFinite(t) ? t : 0
}

export function eventLocationLabel(e: DclEvent): string {
  if (e.world) return 'World'
  const x = typeof e.x === 'number' ? e.x : Array.isArray(e.coordinates) ? e.coordinates[0] : undefined
  const y = typeof e.y === 'number' ? e.y : Array.isArray(e.coordinates) ? e.coordinates[1] : undefined
  if (typeof x === 'number' && typeof y === 'number') return `${x}, ${y}`
  return 'Decentraland'
}

export function dedupeEventsById(events: DclEvent[]): DclEvent[] {
  const seen = new Set<string>()
  const out: DclEvent[] = []
  for (const ev of events) {
    const id = typeof ev.id === 'string' ? ev.id.trim() : ''
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(ev)
  }
  return out
}

export async function fetchDclEvents(params: {
  list: DclEventListFilter
  world?: DclEventWorldFilter
  limit?: number
}): Promise<DclEvent[]> {
  const u = new URL(EVENTS_LIST_URL)
  u.searchParams.set('list', params.list)
  u.searchParams.set('order', 'asc')
  const lim = Math.min(Math.max(1, params.limit ?? 100), 100)
  u.searchParams.set('limit', String(lim))
  const world = params.world ?? 'all'
  if (world === 'genesis') u.searchParams.set('world', 'false')
  if (world === 'worlds') u.searchParams.set('world', 'true')

  const r = await fetch(u.toString())
  if (!r.ok) throw new Error(`Events request failed (${r.status})`)
  const j = (await r.json()) as { ok?: boolean; data?: unknown }
  if (!j.ok || !Array.isArray(j.data)) throw new Error('Unexpected events response')
  return dedupeEventsById(j.data as DclEvent[])
}

export async function fetchDclActiveEventsWithLive(limit = 100): Promise<DclEvent[]> {
  const [active, live] = await Promise.all([
    fetchDclEvents({ list: 'active', limit }),
    fetchDclEvents({ list: 'live', limit })
  ])
  return dedupeEventsById([...live, ...active])
}

export const ROLLING_EVENTS_DAY_COLUMNS = 4

export type RollingLocalDayColumn = {
  dayStartMs: number
  headingLabel: string
  events: DclEvent[]
}

export function localDayStartMs(ms: number): number {
  const d = new Date(ms)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0).getTime()
}

function addLocalDays(dayStartMs: number, deltaDays: number): number {
  const d = new Date(dayStartMs)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + deltaDays, 0, 0, 0, 0).getTime()
}

function formatRollingDayHeading(colDayStartMs: number, todayStartMs: number): string {
  const tomorrowMs = addLocalDays(todayStartMs, 1)
  if (colDayStartMs === todayStartMs) return 'Today'
  if (colDayStartMs === tomorrowMs) return 'Tomorrow'
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  }).format(new Date(colDayStartMs))
}

/** Rolling columns: today + next N−1 local days (default 4). */
export function groupEventsIntoRollingLocalDays(
  events: DclEvent[],
  opts: { windowOffsetDays?: number; columnCount?: number; nowMs?: number } = {}
): RollingLocalDayColumn[] {
  const columnCount = opts.columnCount ?? ROLLING_EVENTS_DAY_COLUMNS
  const nowMs = opts.nowMs ?? Date.now()
  const now = new Date(nowMs)
  const todayStartMs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0).getTime()
  const firstColMs = addLocalDays(todayStartMs, opts.windowOffsetDays ?? 0)
  const windowEndExclusive = addLocalDays(firstColMs, columnCount)

  const columns: RollingLocalDayColumn[] = []
  for (let i = 0; i < columnCount; i++) {
    const dayStartMs = addLocalDays(firstColMs, i)
    columns.push({
      dayStartMs,
      headingLabel: formatRollingDayHeading(dayStartMs, todayStartMs),
      events: []
    })
  }

  const sorted = [...events].sort((a, b) => {
    const aLive = isEventLiveNow(a, nowMs)
    const bLive = isEventLiveNow(b, nowMs)
    if (aLive !== bLive) return aLive ? -1 : 1
    return eventSortTimeMs(a) - eventSortTimeMs(b)
  })

  for (const ev of sorted) {
    const ms = eventOccurrenceStartMs(ev)
    if (!Number.isFinite(ms) || ms <= 0) continue
    const evDay = localDayStartMs(ms)
    if (evDay < firstColMs || evDay >= windowEndExclusive) continue
    for (let i = 0; i < columnCount; i++) {
      if (columns[i]!.dayStartMs === evDay) {
        columns[i]!.events.push(ev)
        break
      }
    }
  }

  return columns
}

export function eventsByLocalDay(events: DclEvent[]): Map<number, DclEvent[]> {
  const map = new Map<number, DclEvent[]>()
  for (const ev of events) {
    const ms = eventOccurrenceStartMs(ev)
    if (!Number.isFinite(ms) || ms <= 0) continue
    const day = localDayStartMs(ms)
    const bucket = map.get(day) ?? []
    bucket.push(ev)
    map.set(day, bucket)
  }
  for (const bucket of map.values()) {
    bucket.sort((a, b) => eventSortTimeMs(a) - eventSortTimeMs(b))
  }
  return map
}
