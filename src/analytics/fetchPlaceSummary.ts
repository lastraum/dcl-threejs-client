import { encodePlaceKeyForUrl } from './placeKey'

export type PlaceSummarySeriesDay = {
  day: string
  scene_enters: number
  landing_views: number
}

export type PlaceSummaryOutbound = {
  place_key: string
  count: number
}

export type PlaceSummary = {
  place_key: string
  window: string
  landing_views: number
  unique_visitors: number
  jump_in_clicks: number
  scene_enters: number
  jump_in_rate: number
  unique_players: number
  multi_visit_rate: number
  median_dwell_ms: number | null
  /** Median time on the 2D scene landing page */
  median_landing_dwell_ms: number | null
  guest_share: number | null
  series: PlaceSummarySeriesDay[]
  top_outbound: PlaceSummaryOutbound[]
}

function emptySummary(placeKey: string, window: string): PlaceSummary {
  return {
    place_key: placeKey,
    window,
    landing_views: 0,
    unique_visitors: 0,
    jump_in_clicks: 0,
    scene_enters: 0,
    jump_in_rate: 0,
    unique_players: 0,
    multi_visit_rate: 0,
    median_dwell_ms: null,
    median_landing_dwell_ms: null,
    guest_share: null,
    series: [],
    top_outbound: []
  }
}

function summaryBase(): string {
  const base = (import.meta.env.VITE_ANALYTICS_URL as string | undefined)?.trim()
  if (base) {
    // VITE_ANALYTICS_URL may point at events endpoint; strip /events if present
    return base.replace(/\/$/, '').replace(/\/events$/i, '')
  }
  return '/api/analytics'
}

export async function fetchPlaceSummary(
  placeKey: string,
  window: '7d' | '30d' = '7d'
): Promise<PlaceSummary> {
  const key = placeKey.trim()
  if (!key) return emptySummary(placeKey, window)
  const url = `${summaryBase()}/places/${encodePlaceKeyForUrl(key)}/summary?window=${window}`
  try {
    const res = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' } })
    if (!res.ok) return emptySummary(key, window)
    const data = (await res.json()) as Partial<PlaceSummary>
    return {
      place_key: typeof data.place_key === 'string' ? data.place_key : key,
      window: typeof data.window === 'string' ? data.window : window,
      landing_views: Number(data.landing_views) || 0,
      unique_visitors: Number(data.unique_visitors) || 0,
      jump_in_clicks: Number(data.jump_in_clicks) || 0,
      scene_enters: Number(data.scene_enters) || 0,
      jump_in_rate: Number(data.jump_in_rate) || 0,
      unique_players: Number(data.unique_players) || 0,
      multi_visit_rate: Number(data.multi_visit_rate) || 0,
      median_dwell_ms:
        data.median_dwell_ms === null || data.median_dwell_ms === undefined
          ? null
          : Number(data.median_dwell_ms) || null,
      median_landing_dwell_ms:
        data.median_landing_dwell_ms === null || data.median_landing_dwell_ms === undefined
          ? null
          : Number(data.median_landing_dwell_ms) || null,
      guest_share:
        data.guest_share === null || data.guest_share === undefined
          ? null
          : Number(data.guest_share),
      series: Array.isArray(data.series)
        ? data.series.map((d) => ({
            day: String((d as PlaceSummarySeriesDay).day ?? ''),
            scene_enters: Number((d as PlaceSummarySeriesDay).scene_enters) || 0,
            landing_views: Number((d as PlaceSummarySeriesDay).landing_views) || 0
          }))
        : [],
      top_outbound: Array.isArray(data.top_outbound)
        ? data.top_outbound.map((o) => ({
            place_key: String((o as PlaceSummaryOutbound).place_key ?? ''),
            count: Number((o as PlaceSummaryOutbound).count) || 0
          }))
        : []
    }
  } catch {
    return emptySummary(key, window)
  }
}
