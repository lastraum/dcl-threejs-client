/**
 * sessionStorage snapshot so a tour leader can rejoin after refresh / tab crash.
 * Followers do not persist — they re-learn the tour via wire heartbeats.
 */
import type { FollowTarget, TourLocationWire } from './communityFollowWire'

const STORAGE_KEY = 'd3js.tour.leaderResume.v1'

export type TourLeaderResumeSnapshot = {
  communityId: string
  sessionId: string
  leaderAddress: string
  lastTarget: FollowTarget | null
  flagDataUrl: string | null
  locations: TourLocationWire[]
  startedAt: number
  /** Wall clock when we last wrote this snapshot. */
  savedAt: number
}

/** Snapshots older than this are discarded (stale after force-end window). */
export const TOUR_RESUME_MAX_AGE_MS = 6 * 60 * 1000

export function loadTourLeaderResume(
  localAddress: string | null | undefined
): TourLeaderResumeSnapshot | null {
  if (typeof sessionStorage === 'undefined') return null
  const local = localAddress?.trim().toLowerCase()
  if (!local) return null
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as TourLeaderResumeSnapshot
    if (!parsed?.communityId || !parsed?.sessionId || !parsed?.leaderAddress) return null
    if (parsed.leaderAddress.toLowerCase() !== local) return null
    if (Date.now() - (parsed.savedAt || 0) > TOUR_RESUME_MAX_AGE_MS) {
      clearTourLeaderResume()
      return null
    }
    return {
      ...parsed,
      communityId: parsed.communityId.toLowerCase(),
      sessionId: parsed.sessionId,
      leaderAddress: parsed.leaderAddress.toLowerCase(),
      lastTarget: parsed.lastTarget ?? null,
      flagDataUrl: parsed.flagDataUrl ?? null,
      locations: Array.isArray(parsed.locations) ? parsed.locations : [],
      startedAt: parsed.startedAt || parsed.savedAt || Date.now(),
      savedAt: parsed.savedAt || Date.now()
    }
  } catch {
    return null
  }
}

export function saveTourLeaderResume(snapshot: TourLeaderResumeSnapshot): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    const next: TourLeaderResumeSnapshot = {
      ...snapshot,
      communityId: snapshot.communityId.toLowerCase(),
      leaderAddress: snapshot.leaderAddress.toLowerCase(),
      savedAt: Date.now()
    }
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    /* quota / private mode */
  }
}

export function clearTourLeaderResume(): void {
  if (typeof sessionStorage === 'undefined') return
  try {
    sessionStorage.removeItem(STORAGE_KEY)
  } catch {
    /* ignore */
  }
}
