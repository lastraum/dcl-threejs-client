/**
 * Shared place-analytics core: normalize, JSONL store, optional Supabase, summaries.
 * Used by server/analytics.mjs and the Vite dev middleware.
 */
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Flat deploy (core next to analytics.mjs): ./data/ · Repo (scripts/): ../data/ */
function defaultEventsPath() {
  const flatSibling = path.join(__dirname, 'analytics.mjs')
  if (fs.existsSync(flatSibling)) {
    return path.join(__dirname, 'data/place-events.jsonl')
  }
  return path.join(__dirname, '../data/place-events.jsonl')
}

const DEFAULT_LOG = process.env.ANALYTICS_EVENTS_PATH?.trim() || defaultEventsPath()

const ALLOWED_EVENTS = new Set([
  'login',
  'logout',
  'landing_view',
  'landing_heartbeat', // legacy alias
  'landing_leave',
  'jump_in_click',
  'scene_load_start',
  'scene_load_fail',
  'scene_enter',
  'heartbeat', // legacy alias
  'active_pulse',
  'scene_leave',
  'goto',
  'navigate',
  'auth_gate_show',
  'auth_gate_complete',
  'scene_ban',
  'stats_panel_open',
  'stats_panel_close',
  'shell_view',
  'landing_chat_ready',
  'landing_cast_live'
])

// --- Anti-spam (in-memory; resets on process restart) -------------------------
const LANDING_VIEW_COOLDOWN_MS = 30_000
const SCENE_ENTER_COOLDOWN_MS = 60_000
const JUMP_IN_COOLDOWN_MS = 15_000
const IP_WINDOW_MS = 60_000
const IP_MAX_REQUESTS = 60
const VISITOR_WINDOW_MS = 60 * 60 * 1000
const VISITOR_MAX_EVENTS = 400
const SOFT_DWELL_CAP_MS = 45 * 60 * 1000
const MIN_DWELL_MS = 3_000

/** @type {Map<string, number>} */
const landingViewCooldown = new Map()
/** @type {Map<string, number>} */
const sceneEnterCooldown = new Map()
/** @type {Map<string, number>} */
const jumpInCooldown = new Map()
/** @type {Map<string, { count: number, start: number }>} */
const ipWindows = new Map()
/** @type {Map<string, { count: number, start: number }>} */
const visitorWindows = new Map()

function pruneMap(map, maxAgeMs) {
  const now = Date.now()
  if (map.size < 5000) return
  for (const [k, v] of map) {
    const t = typeof v === 'number' ? v : v?.start
    if (typeof t === 'number' && now - t > maxAgeMs) map.delete(k)
  }
}

function clientIp(req) {
  const xff = req?.headers?.['x-forwarded-for']
  if (typeof xff === 'string' && xff.trim()) return xff.split(',')[0].trim().slice(0, 64)
  return (req?.socket?.remoteAddress || 'unknown').slice(0, 64)
}

function rateWindowAllow(map, key, windowMs, maxCount) {
  const now = Date.now()
  const cur = map.get(key)
  if (!cur || now - cur.start > windowMs) {
    map.set(key, { count: 1, start: now })
    return true
  }
  if (cur.count >= maxCount) return false
  cur.count += 1
  return true
}

function cooldownAllow(map, key, cooldownMs) {
  const now = Date.now()
  const prev = map.get(key)
  if (prev && now - prev < cooldownMs) return false
  map.set(key, now)
  return true
}

/**
 * Drop spammy events; keep valid ones.
 * @param {object[]} normalized
 * @param {{ ip?: string }} [ctx]
 */
function filterAntiSpam(normalized, ctx = {}) {
  const ip = ctx.ip || 'unknown'
  pruneMap(landingViewCooldown, LANDING_VIEW_COOLDOWN_MS * 4)
  pruneMap(sceneEnterCooldown, SCENE_ENTER_COOLDOWN_MS * 4)
  pruneMap(jumpInCooldown, JUMP_IN_COOLDOWN_MS * 4)
  pruneMap(ipWindows, IP_WINDOW_MS * 2)
  pruneMap(visitorWindows, VISITOR_WINDOW_MS * 2)

  if (!rateWindowAllow(ipWindows, ip, IP_WINDOW_MS, IP_MAX_REQUESTS)) {
    return { accepted: [], rejected: normalized.length, reason: 'ip_rate' }
  }

  const out = []
  for (const e of normalized) {
    const vid = e.visitor_id || 'anon'
    if (!rateWindowAllow(visitorWindows, vid, VISITOR_WINDOW_MS, VISITOR_MAX_EVENTS)) {
      continue
    }
    const place = e.place_key || '_'
    const vp = `${vid}|${place}`

    if (e.event === 'landing_view') {
      if (!cooldownAllow(landingViewCooldown, vp, LANDING_VIEW_COOLDOWN_MS)) continue
    } else if (e.event === 'scene_enter') {
      if (!cooldownAllow(sceneEnterCooldown, vp, SCENE_ENTER_COOLDOWN_MS)) continue
    } else if (e.event === 'jump_in_click') {
      if (!cooldownAllow(jumpInCooldown, vp, JUMP_IN_COOLDOWN_MS)) continue
    }

    // Soft-cap dwell on leave events at ingest for storage consistency
    if ((e.event === 'landing_leave' || e.event === 'scene_leave') && e.props) {
      const d = Number(e.props.dwell_ms)
      if (Number.isFinite(d)) {
        e.props = {
          ...e.props,
          dwell_ms: Math.min(Math.max(0, d), SOFT_DWELL_CAP_MS)
        }
      }
    }
    out.push(e)
  }
  return { accepted: out, rejected: normalized.length - out.length, reason: null }
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WALLET_RE = /^0x[a-f0-9]{40}$/

function isUuid(v) {
  return typeof v === 'string' && UUID_RE.test(v)
}

function clampStr(v, max) {
  if (typeof v !== 'string') return undefined
  const t = v.trim()
  if (!t) return undefined
  return t.length > max ? t.slice(0, max) : t
}

export function resolveEventsPath() {
  return DEFAULT_LOG
}

export function ensureEventsFile() {
  const p = resolveEventsPath()
  fs.mkdirSync(path.dirname(p), { recursive: true })
  if (!fs.existsSync(p)) fs.writeFileSync(p, '', 'utf8')
  return p
}

/** @returns {object | null} */
export function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null
  const event = clampStr(raw.event, 64)
  if (!event || !ALLOWED_EVENTS.has(event)) return null
  const event_id = isUuid(raw.event_id) ? raw.event_id : null
  const visitor_id = isUuid(raw.visitor_id) ? raw.visitor_id : null
  const session_id = isUuid(raw.session_id) ? raw.session_id : null
  if (!event_id || !visitor_id || !session_id) return null

  const login_kind = raw.login_kind === 'wallet' ? 'wallet' : 'guest'
  const at = typeof raw.at === 'string' && raw.at.length >= 10 ? raw.at : new Date().toISOString()
  const client_version = clampStr(raw.client_version, 32) || '0'
  const pathStr = clampStr(raw.path, 512) || '/'

  /** @type {Record<string, unknown>} */
  const row = {
    event_id,
    event,
    at,
    received_at: new Date().toISOString(),
    visitor_id,
    session_id,
    login_kind,
    client_version,
    path: pathStr,
    props: raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props) ? raw.props : {}
  }

  if (isUuid(raw.play_session_id)) row.play_session_id = raw.play_session_id
  if (typeof raw.wallet === 'string' && WALLET_RE.test(raw.wallet.trim().toLowerCase())) {
    row.wallet = raw.wallet.trim().toLowerCase()
  }
  const source = clampStr(raw.source, 32)
  if (source) row.source = source
  const ua = clampStr(raw.ua_class, 16)
  if (ua) row.ua_class = ua

  if (raw.place_kind === 'coords' || raw.place_kind === 'world' || raw.place_kind === 'shell') {
    row.place_kind = raw.place_kind
  }
  const place_key = clampStr(raw.place_key, 200)
  if (place_key) row.place_key = place_key
  const world_name = clampStr(raw.world_name, 200)
  if (world_name) row.world_name = world_name
  if (Number.isFinite(raw.x)) row.x = Math.trunc(Number(raw.x))
  if (Number.isFinite(raw.y)) row.y = Math.trunc(Number(raw.y))
  const from_place_key = clampStr(raw.from_place_key, 200)
  if (from_place_key) row.from_place_key = from_place_key
  const to_place_key = clampStr(raw.to_place_key, 200)
  if (to_place_key) row.to_place_key = to_place_key

  return row
}

/**
 * @param {unknown} events
 * @param {{ ip?: string }} [ctx]
 */
export async function appendEvents(events, ctx = {}) {
  const list = Array.isArray(events) ? events : [events]
  const normalized = []
  for (const raw of list.slice(0, 20)) {
    const n = normalizeEvent(raw)
    if (n) normalized.push(n)
  }
  if (normalized.length === 0) return { accepted: 0, rejected: 0 }

  const filtered = filterAntiSpam(normalized, ctx)
  if (filtered.accepted.length === 0) {
    return {
      accepted: 0,
      rejected: filtered.rejected || normalized.length,
      reason: filtered.reason || 'cooldown'
    }
  }

  const logPath = ensureEventsFile()
  const lines = filtered.accepted.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await fs.promises.appendFile(logPath, lines, 'utf8')

  const supabase = await pushToSupabase(filtered.accepted)
  return {
    accepted: filtered.accepted.length,
    rejected: filtered.rejected,
    reason: filtered.reason,
    supabase
  }
}

async function pushToSupabase(rows) {
  const url = process.env.SUPABASE_URL?.trim()
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim()
  if (!url || !key) return { ok: false, skipped: true }

  const endpoint = `${url.replace(/\/$/, '')}/rest/v1/place_events`
  const payload = rows.map((r) => ({
    event_id: r.event_id,
    event: r.event,
    at: r.at,
    received_at: r.received_at,
    visitor_id: r.visitor_id,
    session_id: r.session_id,
    play_session_id: r.play_session_id ?? null,
    login_kind: r.login_kind,
    wallet: r.wallet ?? null,
    client_version: r.client_version,
    path: r.path,
    source: r.source ?? null,
    ua_class: r.ua_class ?? null,
    place_kind: r.place_kind ?? null,
    place_key: r.place_key ?? null,
    world_name: r.world_name ?? null,
    x: r.x ?? null,
    y: r.y ?? null,
    from_place_key: r.from_place_key ?? null,
    to_place_key: r.to_place_key ?? null,
    props: r.props ?? {}
  }))

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        apikey: key,
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates,return=minimal'
      },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      console.error('[analytics] supabase insert failed', res.status, text.slice(0, 200))
      return { ok: false, status: res.status }
    }
    return { ok: true }
  } catch (err) {
    console.error('[analytics] supabase error', err)
    return { ok: false, error: String(err) }
  }
}

function dayKey(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().slice(0, 10)
}

function readAllEvents() {
  const p = ensureEventsFile()
  const text = fs.readFileSync(p, 'utf8')
  const out = []
  for (const line of text.split('\n')) {
    if (!line.trim()) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      /* skip bad line */
    }
  }
  return out
}

function median(nums) {
  if (nums.length === 0) return null
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 === 0 ? Math.round((s[mid - 1] + s[mid]) / 2) : s[mid]
}

/**
 * @param {string} placeKey
 * @param {'7d'|'30d'} window
 */
export function computePlaceSummary(placeKey, window = '7d') {
  const days = window === '30d' ? 30 : 7
  const since = Date.now() - days * 24 * 60 * 60 * 1000
  const events = readAllEvents().filter((e) => {
    if (!e || e.place_key !== placeKey) return false
    const t = Date.parse(e.at)
    return Number.isFinite(t) && t >= since
  })

  let landing_views = 0
  let jump_in_clicks = 0
  let scene_enters = 0
  const landingVisitors = new Set()
  const playerVisitors = new Set()
  const playSessionsByVisitor = new Map()
  const dwellByPlaySession = new Map()
  const dwellByLandingSession = new Map()
  let guestEnters = 0
  let walletEnters = 0
  const outbound = new Map()
  /** @type {Map<string, { landing_views: number, scene_enters: number }>} */
  const byDay = new Map()

  const ensureDay = (day) => {
    if (!byDay.has(day)) byDay.set(day, { landing_views: 0, scene_enters: 0 })
    return byDay.get(day)
  }

  for (const e of events) {
    const day = dayKey(e.at)
    if (e.event === 'landing_view') {
      landing_views++
      if (e.visitor_id) landingVisitors.add(e.visitor_id)
      if (day) ensureDay(day).landing_views++
    } else if (e.event === 'jump_in_click') {
      jump_in_clicks++
    } else if (e.event === 'scene_enter') {
      scene_enters++
      if (e.visitor_id) {
        playerVisitors.add(e.visitor_id)
        if (!playSessionsByVisitor.has(e.visitor_id)) playSessionsByVisitor.set(e.visitor_id, new Set())
        if (e.play_session_id) playSessionsByVisitor.get(e.visitor_id).add(e.play_session_id)
      }
      if (e.login_kind === 'wallet') walletEnters++
      else guestEnters++
      if (day) ensureDay(day).scene_enters++
    } else if (e.event === 'scene_leave') {
      const dwell = Number(e.props?.dwell_ms)
      if (e.play_session_id && Number.isFinite(dwell) && dwell >= MIN_DWELL_MS) {
        dwellByPlaySession.set(
          e.play_session_id,
          Math.min(dwell, SOFT_DWELL_CAP_MS)
        )
      }
    } else if (e.event === 'landing_leave') {
      const dwell = Number(e.props?.dwell_ms)
      const lid =
        typeof e.props?.landing_session_id === 'string' ? e.props.landing_session_id : null
      if (lid && Number.isFinite(dwell) && dwell >= MIN_DWELL_MS) {
        dwellByLandingSession.set(lid, Math.min(dwell, SOFT_DWELL_CAP_MS))
      }
    } else if (e.event === 'goto' || e.event === 'navigate') {
      if (e.from_place_key === placeKey && e.to_place_key && e.to_place_key !== placeKey) {
        outbound.set(e.to_place_key, (outbound.get(e.to_place_key) || 0) + 1)
      }
    }
  }

  let multi = 0
  for (const set of playSessionsByVisitor.values()) {
    if (set.size >= 2) multi++
  }
  const unique_players = playerVisitors.size
  const multi_visit_rate = unique_players > 0 ? multi / unique_players : 0
  const jump_in_rate = landing_views > 0 ? scene_enters / landing_views : 0
  const enterTotal = guestEnters + walletEnters
  const guest_share = enterTotal > 0 ? guestEnters / enterTotal : null
  const median_dwell_ms = median([...dwellByPlaySession.values()])
  const median_landing_dwell_ms = median([...dwellByLandingSession.values()])

  // Build contiguous series for last N days
  const series = []
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000)
    const key = d.toISOString().slice(0, 10)
    const row = byDay.get(key) || { landing_views: 0, scene_enters: 0 }
    series.push({ day: key, scene_enters: row.scene_enters, landing_views: row.landing_views })
  }

  const top_outbound = [...outbound.entries()]
    .map(([place_key, count]) => ({ place_key, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 5)

  return {
    place_key: placeKey,
    window: window === '30d' ? '30d' : '7d',
    landing_views,
    unique_visitors: landingVisitors.size,
    jump_in_clicks,
    scene_enters,
    jump_in_rate: Math.round(jump_in_rate * 1000) / 1000,
    unique_players,
    multi_visit_rate: Math.round(multi_visit_rate * 1000) / 1000,
    median_landing_dwell_ms,
    median_dwell_ms,
    guest_share: guest_share === null ? null : Math.round(guest_share * 1000) / 1000,
    series,
    top_outbound
  }
}

/**
 * Minimal HTTP handler for analytics routes.
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {{ url?: string }} [opts]
 */
export async function handleAnalyticsRequest(req, res, opts = {}) {
  const urlRaw = opts.url ?? req.url ?? '/'
  const host = req.headers.host || 'localhost'
  const u = new URL(urlRaw, `http://${host}`)
  const pathname = u.pathname

  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  }

  const send = (status, body, headers = {}) => {
    const payload = typeof body === 'string' ? body : JSON.stringify(body)
    res.writeHead(status, {
      'Content-Type': 'application/json',
      ...cors,
      ...headers
    })
    res.end(payload)
  }

  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    res.end()
    return true
  }

  if (req.method === 'GET' && pathname === '/health') {
    send(200, { ok: true, service: 'place-analytics' })
    return true
  }

  // Legacy login endpoint → map into place_events
  if (req.method === 'POST' && pathname === '/api/analytics/login') {
    const text = await readBody(req)
    let raw = {}
    try {
      raw = text ? JSON.parse(text) : {}
    } catch {
      send(400, { error: 'bad_json' })
      return true
    }
    const event = {
      event_id: randomUUID(),
      event: 'login',
      at: typeof raw.at === 'string' ? raw.at : new Date().toISOString(),
      visitor_id: randomUUID(),
      session_id: randomUUID(),
      login_kind: raw.kind === 'wallet' ? 'wallet' : 'guest',
      wallet: raw.address,
      client_version: raw.version || '0',
      path: raw.path || '/',
      props: {}
    }
    const result = await appendEvents([event])
    if (result.accepted === 0) {
      send(400, { error: 'bad_request' })
      return true
    }
    res.writeHead(204, cors)
    res.end()
    return true
  }

  if (req.method === 'POST' && pathname === '/api/analytics/events') {
    const text = await readBody(req)
    if (text.length > 48_000) {
      send(413, { error: 'too_large' })
      return true
    }
    let body
    try {
      body = text ? JSON.parse(text) : {}
    } catch {
      send(400, { error: 'bad_json' })
      return true
    }
    const events = Array.isArray(body) ? body : body.events
    const ip = clientIp(req)
    const result = await appendEvents(events, { ip })
    if (result.accepted === 0) {
      if (result.reason === 'ip_rate') {
        send(429, { error: 'rate_limited', reason: 'ip_rate' })
        return true
      }
      // Soft-refresh / cooldowns: not an error — client should not retry.
      send(202, {
        ok: true,
        accepted: 0,
        rejected: result.rejected || 0,
        reason: result.reason || 'cooldown'
      })
      return true
    }
    send(202, {
      ok: true,
      accepted: result.accepted,
      rejected: result.rejected || 0
    })
    return true
  }

  const summaryMatch = pathname.match(/^\/api\/analytics\/places\/([^/]+)\/summary$/)
  if (req.method === 'GET' && summaryMatch) {
    let placeKey = summaryMatch[1]
    try {
      placeKey = decodeURIComponent(placeKey)
    } catch {
      /* keep */
    }
    const window = u.searchParams.get('window') === '30d' ? '30d' : '7d'
    const summary = computePlaceSummary(placeKey, window)
    send(200, summary, { 'Cache-Control': 'public, max-age=60' })
    return true
  }

  return false
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
