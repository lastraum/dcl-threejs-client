/**
 * Session-only community Follow / Tour state (one leader per community).
 *
 * - Mods/owners start a tour (Lead)
 * - Members opt in via Follow in community chat
 * - Follow = hard /goto only: leader intentional jumps emit goto pulses; followers jump
 * - Soft parcel walk only updates lastTarget for UI labels (no wire goto, no reload)
 * - Auto-pilot (buffer-follow leader feet) is a separate future mode — not this path
 * - Heartbeats re-announce tour + last stop for late joiners / label sync (no jump)
 * - Leader disconnect: followers mark leader_away after missed heartbeats; force-end
 *   after 5 minutes without a leader. Leaders can resume via sessionStorage snapshot.
 */

import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { RouteTarget } from '../dcl/content/route'
import {
  canPostCommunityAnnouncements
} from './communityPermissions'
import {
  followCamEqual,
  followTargetLabel,
  followTargetsEqual,
  newFollowSessionId,
  newTourLocationId,
  quantizeFollowCam,
  routeToFollowTarget,
  TOUR_LOCATIONS_WIRE_CAP,
  type FollowCamState,
  type FollowTarget,
  type FollowWireMsg,
  type TourLocationWire
} from './communityFollowWire'
import {
  clearTourLeaderResume,
  loadTourLeaderResume,
  saveTourLeaderResume,
  type TourLeaderResumeSnapshot
} from './tourLeaderResumeStore'
import type { CommunityListRow } from './types'

const HEARTBEAT_MS = 45_000
/** Soft “leader away” after ~2 missed heartbeats. */
const LEADER_AWAY_AFTER_MS = 90_000
/** Hard end tour if leader has not heartbeated for this long. */
const LEADER_FORCE_END_MS = 5 * 60 * 1000
const LEASE_TICK_MS = 10_000
const GOTO_MIN_INTERVAL_MS = 3_000
/** Leader freecam stream while Tour Focus is on. */
const CAM_PUBLISH_INTERVAL_MS = 100

export type CommunityTourSession = {
  communityId: string
  sessionId: string
  leaderAddress: string
  lastTarget: FollowTarget | null
  startedAt: number
  /** Leader flag banner image (data URL), if set. */
  flagDataUrl: string | null
  /** Follower wallets (lowercase) — tracked by leader via join/leave wire. */
  followerAddresses: string[]
  /** Leader Tour Focus — take over follower cameras. */
  focusActive: boolean
  /** Last freecam snapshot from leader (for late joiners / UI). */
  lastCam: FollowCamState | null
  /** Tour stops (coords + scene names). Photos are leader-local only. */
  locations: TourLocationWire[]
  /** When the current stop started (dwell timer). */
  locationEnteredAt: number | null
  /** Last time we saw leader start/hb (wall clock). */
  lastLeaderSeenAt: number
  /** True after LEADER_AWAY_AFTER_MS without leader heartbeat. */
  leaderAway: boolean
}

export type TourRosterEntry = {
  address: string
  isLeader: boolean
}

export type CommunityFollowEvent =
  | {
      kind: 'tour_started'
      communityId: string
      session: CommunityTourSession
      isLocalLeader: boolean
      /** True when learned via heartbeat (late join) rather than initial start. */
      lateJoin: boolean
    }
  | { kind: 'tour_ended'; communityId: string; sessionId: string }
  | { kind: 'follow_goto'; communityId: string; target: FollowTarget; sessionId: string }
  | {
      kind: 'flag_changed'
      communityId: string
      sessionId: string
      leaderAddress: string
      flagDataUrl: string | null
    }
  | {
      kind: 'focus_changed'
      communityId: string
      sessionId: string
      leaderAddress: string
      focusActive: boolean
    }
  | {
      kind: 'cam_update'
      communityId: string
      sessionId: string
      leaderAddress: string
      cam: FollowCamState
    }
  | {
      kind: 'leader_away'
      communityId: string
      sessionId: string
      leaderAddress: string
      /** ms until force-end from last seen. */
      forceEndInMs: number
    }
  | {
      kind: 'leader_back'
      communityId: string
      sessionId: string
      leaderAddress: string
    }
  | {
      /** Local wallet has a resumable tour after refresh/disconnect. */
      kind: 'leader_resume_available'
      snapshot: TourLeaderResumeSnapshot
    }
  | { kind: 'changed' }

export type CommunityFollowControllerOptions = {
  /** Publish control on PM-room non-chat data path (not community chat SFU). */
  publish: (communityId: string, msg: FollowWireMsg) => Promise<boolean>
  getLocalAddress: () => string | null
  getCommunities: () => CommunityListRow[]
}

export class CommunityFollowController {
  private readonly publish: CommunityFollowControllerOptions['publish']
  private readonly getLocalAddress: CommunityFollowControllerOptions['getLocalAddress']
  private readonly getCommunities: CommunityFollowControllerOptions['getCommunities']

  /** Active tour per community (at most one). */
  private readonly sessions = new Map<string, CommunityTourSession>()
  /** Session ids we already toast-notified (start or late hb). */
  private readonly toastedSessions = new Set<string>()
  /** Local user is leading this community. */
  private leadingCommunityId: string | null = null
  private leadingSessionId: string | null = null
  /** Local user is following a tour in this community. */
  private followingCommunityId: string | null = null
  private followingSessionId: string | null = null

  private heartbeatTimer = 0
  private leaseTimer = 0
  private lastGotoSentAt = 0
  /** Last hard /goto actually published on the wire (not soft label updates). */
  private lastPublishedGoto: FollowTarget | null = null
  /** Coalesce hard /goto spam so rate-limit still flushes the latest intentional jump. */
  private pendingGotoTimer = 0
  private pendingGotoTarget: FollowTarget | null = null
  /** Leader: throttle freecam publish while Focus is on. */
  private lastCamSentAt = 0
  private lastPublishedCam: FollowCamState | null = null
  private disposed = false
  private readonly listeners = new Set<(ev: CommunityFollowEvent) => void>()
  private readonly onPageHide = (): void => {
    this.persistLeaderResumeIfLeading()
    this.bestEffortFollowerLeave()
  }

  constructor(opts: CommunityFollowControllerOptions) {
    this.publish = opts.publish
    this.getLocalAddress = opts.getLocalAddress
    this.getCommunities = opts.getCommunities
    this.startLeaseWatch()
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHide)
      window.addEventListener('beforeunload', this.onPageHide)
    }
  }

  subscribe(listener: (ev: CommunityFollowEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * After controller is wired, check sessionStorage for a leader resume prompt.
   * Emits `leader_resume_available` when a valid snapshot exists for this wallet.
   */
  checkLeaderResumeOffer(): TourLeaderResumeSnapshot | null {
    const snap = loadTourLeaderResume(this.getLocalAddress())
    if (!snap) return null
    // Already leading this session — no prompt.
    if (
      this.leadingCommunityId === snap.communityId &&
      this.leadingSessionId === snap.sessionId
    ) {
      return null
    }
    this.emit({ kind: 'leader_resume_available', snapshot: snap })
    return snap
  }

  getPendingLeaderResume(): TourLeaderResumeSnapshot | null {
    return loadTourLeaderResume(this.getLocalAddress())
  }

  /**
   * Leader chose Rejoin — republish start with same session id and resume leading.
   * Returns lastTarget so the UI can teleport the leader.
   */
  async resumeLeadFromSnapshot(): Promise<{
    ok: boolean
    target: FollowTarget | null
    communityId: string | null
  }> {
    const snap = loadTourLeaderResume(this.getLocalAddress())
    if (!snap) return { ok: false, target: null, communityId: null }
    const ok = await this.startLead(snap.communityId, snap.lastTarget, {
      resume: snap
    })
    if (!ok) return { ok: false, target: null, communityId: snap.communityId }
    return { ok: true, target: snap.lastTarget, communityId: snap.communityId }
  }

  /**
   * Leader chose Cancel on the rejoin panel — end the tour for everyone if we still
   * can, and drop the resume snapshot.
   */
  async cancelLeaderResume(): Promise<void> {
    const snap = loadTourLeaderResume(this.getLocalAddress())
    clearTourLeaderResume()
    if (!snap) return
    const local = this.getLocalAddress()?.toLowerCase() ?? snap.leaderAddress
    // Best-effort stop so followers don't wait the full 5 min lease.
    void this.publish(snap.communityId, {
      t: 'stop',
      s: snap.sessionId,
      l: local,
      at: Date.now()
    })
    // Local cleanup if we still hold this session in memory.
    const existing = this.sessions.get(snap.communityId)
    if (existing && existing.sessionId === snap.sessionId) {
      this.applyStop(snap.communityId, local, snap.sessionId, local)
    }
    if (this.leadingSessionId === snap.sessionId) {
      this.clearLocalLead()
    }
    this.emit({ kind: 'changed' })
  }

  dispose(): void {
    this.disposed = true
    this.persistLeaderResumeIfLeading()
    this.bestEffortFollowerLeave()
    this.stopHeartbeat()
    this.stopLeaseWatch()
    this.clearPendingGoto()
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHide)
      window.removeEventListener('beforeunload', this.onPageHide)
    }
    this.sessions.clear()
    this.toastedSessions.clear()
    this.leadingCommunityId = null
    this.leadingSessionId = null
    this.followingCommunityId = null
    this.followingSessionId = null
    this.lastPublishedGoto = null
    this.lastPublishedCam = null
    this.lastCamSentAt = 0
    this.listeners.clear()
  }

  /** Local user is leading and Tour Focus is currently on. */
  isFocusBroadcasting(): boolean {
    if (!this.leadingCommunityId) return false
    const s = this.sessions.get(this.leadingCommunityId)
    return Boolean(s?.focusActive)
  }

  /** Local follower is under leader Tour Focus. */
  isFocusReceiving(): boolean {
    if (!this.followingCommunityId) return false
    const s = this.sessions.get(this.followingCommunityId)
    return Boolean(s?.focusActive)
  }

  isFocusActive(communityId?: string): boolean {
    const id = (communityId ?? this.leadingCommunityId ?? this.followingCommunityId)?.trim().toLowerCase()
    if (!id) return false
    return Boolean(this.sessions.get(id)?.focusActive)
  }

  getLastCam(communityId?: string): FollowCamState | null {
    const id = (communityId ?? this.leadingCommunityId ?? this.followingCommunityId)?.trim().toLowerCase()
    if (!id) return null
    return this.sessions.get(id)?.lastCam ?? null
  }

  getSession(communityId: string): CommunityTourSession | null {
    return this.sessions.get(communityId.trim().toLowerCase()) ?? null
  }

  /** All tours this client currently knows about (start / hb / goto wire). */
  listSessions(): CommunityTourSession[] {
    return [...this.sessions.values()]
  }

  /**
   * Leader + followers for the local tour (prefer leading, else following).
   * Count = roster length.
   */
  getTourRoster(communityId?: string): TourRosterEntry[] {
    const id = (communityId ?? this.leadingCommunityId ?? this.followingCommunityId)?.trim().toLowerCase()
    if (!id) return []
    const session = this.sessions.get(id)
    if (!session) return []
    const leader = session.leaderAddress.toLowerCase()
    const followers = session.followerAddresses
      .map((a) => a.toLowerCase())
      .filter((a) => a && a !== leader && ADDR_RE.test(a))
    const seen = new Set<string>([leader])
    const out: TourRosterEntry[] = [{ address: leader, isLeader: true }]
    for (const a of followers) {
      if (seen.has(a)) continue
      seen.add(a)
      out.push({ address: a, isLeader: false })
    }
    return out
  }

  isLeading(communityId?: string): boolean {
    if (!this.leadingCommunityId) return false
    if (!communityId) return true
    return this.leadingCommunityId === communityId.trim().toLowerCase()
  }

  isFollowing(communityId?: string): boolean {
    if (!this.followingCommunityId) return false
    if (!communityId) return true
    return this.followingCommunityId === communityId.trim().toLowerCase()
  }

  canLead(communityId: string): boolean {
    const id = communityId.trim().toLowerCase()
    const row = this.getCommunities().find((c) => c.id.toLowerCase() === id)
    if (!row) return false
    return canPostCommunityAnnouncements(row.role, this.getLocalAddress(), row.ownerAddress)
  }

  /**
   * Start a tour (mod/owner). One leader per community — fails if another tour is live.
   * Pass `resume` to rejoin the same sessionId after a disconnect/refresh.
   */
  async startLead(
    communityId: string,
    initialTarget?: FollowTarget | null,
    opts?: { resume?: TourLeaderResumeSnapshot }
  ): Promise<boolean> {
    if (this.disposed) return false
    const id = communityId.trim().toLowerCase()
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    if (!id || !local || !ADDR_RE.test(local)) return false
    if (!this.canLead(id)) {
      clientDebugLog.log('social', 'Follow tour: not allowed to lead', { level: 'warn' })
      return false
    }

    const resume = opts?.resume
    if (resume && resume.leaderAddress.toLowerCase() !== local) {
      return false
    }

    const existing = this.sessions.get(id)
    if (existing && existing.leaderAddress !== local && existing.sessionId !== resume?.sessionId) {
      clientDebugLog.log('social', 'Follow tour: another leader is active', { level: 'warn' })
      return false
    }

    // Stop previous local lead if switching communities.
    if (this.leadingCommunityId && this.leadingCommunityId !== id) {
      await this.stopLead()
    }

    const now = Date.now()
    const sessionId =
      resume?.sessionId ||
      (existing?.sessionId && existing.leaderAddress === local
        ? existing.sessionId
        : newFollowSessionId())
    const target =
      initialTarget ?? resume?.lastTarget ?? existing?.lastTarget ?? null
    const sameSession =
      (existing?.sessionId === sessionId && existing.leaderAddress === local) ||
      Boolean(resume && resume.sessionId === sessionId)
    const session: CommunityTourSession = {
      communityId: id,
      sessionId,
      leaderAddress: local,
      lastTarget: target,
      startedAt: resume?.startedAt ?? (sameSession && existing ? existing.startedAt : now),
      flagDataUrl:
        resume?.flagDataUrl ??
        (existing?.leaderAddress === local ? existing.flagDataUrl : null),
      // New session clears roster; resume same session keeps prior followers if any.
      followerAddresses:
        sameSession && existing ? [...existing.followerAddresses] : [],
      // Focus does not auto-resume — leader must re-enable after restart.
      focusActive: false,
      lastCam: null,
      locations:
        resume?.locations?.length
          ? [...resume.locations]
          : sameSession && existing
            ? [...existing.locations]
            : [],
      locationEnteredAt: sameSession && existing ? existing.locationEnteredAt : null,
      lastLeaderSeenAt: now,
      leaderAway: false
    }

    const startMsg: FollowWireMsg = {
      t: 'start',
      s: sessionId,
      l: local,
      at: now,
      ...(target ? { target } : {}),
      ...(session.flagDataUrl ? { flag: session.flagDataUrl } : {}),
      focus: false,
      ...(session.locations.length ? { locations: session.locations } : {})
    }
    const ok = await this.publish(id, startMsg)
    if (!ok) return false

    this.sessions.set(id, session)
    this.leadingCommunityId = id
    this.leadingSessionId = sessionId
    // Leader is not "following" themselves.
    if (this.followingCommunityId === id) {
      this.followingCommunityId = null
      this.followingSessionId = null
    }
    this.toastedSessions.add(sessionId)
    this.startHeartbeat()
    this.persistLeaderResumeIfLeading()
    this.emit({
      kind: 'tour_started',
      communityId: id,
      session,
      isLocalLeader: true,
      lateJoin: Boolean(resume)
    })
    this.emit({ kind: 'changed' })
    clientDebugLog.log(
      'social',
      `Follow tour ${resume ? 'resumed' : 'started'} · community=${id.slice(0, 8)}… · target=${followTargetLabel(target) || 'none'}`,
      { level: 'success', alsoConsole: true }
    )
    return true
  }

  async stopLead(): Promise<boolean> {
    if (this.disposed) return false
    const id = this.leadingCommunityId
    const sessionId = this.leadingSessionId
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    if (!id || !sessionId || !local) {
      this.clearLocalLead()
      clearTourLeaderResume()
      return false
    }

    const ok = await this.publish(id, { t: 'stop', s: sessionId, l: local, at: Date.now() })
    this.clearLocalLead()
    clearTourLeaderResume()
    const had = this.sessions.get(id)
    if (had && had.sessionId === sessionId) {
      this.sessions.delete(id)
      this.emit({ kind: 'tour_ended', communityId: id, sessionId })
    }
    this.emit({ kind: 'changed' })
    return ok
  }

  /** Opt in to the active tour for this community; jump to last stop if known. */
  follow(communityId: string): boolean {
    if (this.disposed) return false
    const id = communityId.trim().toLowerCase()
    const session = this.sessions.get(id)
    if (!session) return false
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    if (local && session.leaderAddress === local) return false
    if (!local || !ADDR_RE.test(local)) return false

    this.followingCommunityId = id
    this.followingSessionId = session.sessionId
    // Announce to leader (and peers) so Tour Options roster updates.
    void this.publish(id, {
      t: 'join',
      s: session.sessionId,
      l: local,
      at: Date.now()
    })
    this.emit({ kind: 'changed' })
    // Apply leader flag immediately if we already learned it via start/hb/flag wire.
    if (session.flagDataUrl) {
      this.emit({
        kind: 'flag_changed',
        communityId: id,
        sessionId: session.sessionId,
        leaderAddress: session.leaderAddress,
        flagDataUrl: session.flagDataUrl
      })
    }
    // Late join into an active Focus session — take over camera immediately.
    if (session.focusActive) {
      this.emit({
        kind: 'focus_changed',
        communityId: id,
        sessionId: session.sessionId,
        leaderAddress: session.leaderAddress,
        focusActive: true
      })
      if (session.lastCam) {
        this.emit({
          kind: 'cam_update',
          communityId: id,
          sessionId: session.sessionId,
          leaderAddress: session.leaderAddress,
          cam: session.lastCam
        })
      }
    }
    if (session.lastTarget) {
      this.emit({
        kind: 'follow_goto',
        communityId: id,
        target: session.lastTarget,
        sessionId: session.sessionId
      })
    }
    clientDebugLog.log(
      'social',
      `Following tour · community=${id.slice(0, 8)}… · stop=${followTargetLabel(session.lastTarget) || 'pending'}`,
      { level: 'info', alsoConsole: true }
    )
    return true
  }

  unfollow(): void {
    const was = this.followingCommunityId
    const session = was ? this.sessions.get(was) : null
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    const wasFocus = Boolean(session?.focusActive)
    this.followingCommunityId = null
    this.followingSessionId = null
    if (session && local && ADDR_RE.test(local)) {
      void this.publish(session.communityId, {
        t: 'leave',
        s: session.sessionId,
        l: local,
        at: Date.now()
      })
    }
    // Drop flag visual for this client when leaving the tour.
    if (session) {
      this.emit({
        kind: 'flag_changed',
        communityId: session.communityId,
        sessionId: session.sessionId,
        leaderAddress: session.leaderAddress,
        flagDataUrl: null
      })
      if (wasFocus) {
        this.emit({
          kind: 'focus_changed',
          communityId: session.communityId,
          sessionId: session.sessionId,
          leaderAddress: session.leaderAddress,
          focusActive: false
        })
      }
    }
    this.emit({ kind: 'changed' })
  }

  /**
   * Leader: set or clear the tour flag image (data URL). Broadcasts on the wire
   * and attaches to the session for heartbeat rebroadcast.
   */
  async setFlagImage(dataUrl: string | null): Promise<boolean> {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return false
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session || session.sessionId !== this.leadingSessionId) return false
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    const flag = dataUrl?.trim() || null
    if (flag && flag.length > 80_000) {
      clientDebugLog.log('social', 'Follow flag image too large', { level: 'warn' })
      return false
    }
    session.flagDataUrl = flag
    this.sessions.set(id, session)
    this.persistLeaderResumeIfLeading()
    const ok = await this.publish(id, {
      t: 'flag',
      s: session.sessionId,
      l: local,
      at: Date.now(),
      flag
    })
    this.emit({
      kind: 'flag_changed',
      communityId: id,
      sessionId: session.sessionId,
      leaderAddress: session.leaderAddress,
      flagDataUrl: flag
    })
    this.emit({ kind: 'changed' })
    return ok
  }

  /**
   * Leader: enable/disable Tour Focus (take over follower freecam + FOV).
   * While on, call {@link tickLeaderCam} each frame with a freecam sample.
   */
  async setFocusActive(on: boolean): Promise<boolean> {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return false
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session || session.sessionId !== this.leadingSessionId) return false
    if (session.focusActive === on) return true
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    session.focusActive = on
    if (!on) {
      session.lastCam = null
      this.lastPublishedCam = null
    }
    this.sessions.set(id, session)
    const ok = await this.publish(id, {
      t: 'focus',
      s: session.sessionId,
      l: local,
      at: Date.now(),
      on
    })
    this.emit({
      kind: 'focus_changed',
      communityId: id,
      sessionId: session.sessionId,
      leaderAddress: session.leaderAddress,
      focusActive: on
    })
    this.emit({ kind: 'changed' })
    clientDebugLog.log(
      'social',
      `Tour Focus ${on ? 'ON' : 'OFF'} · community=${id.slice(0, 8)}…`,
      { level: 'info', alsoConsole: true }
    )
    return ok
  }

  /**
   * Leader frame tick: publish freecam while Focus is on (~10 Hz).
   * `sample` should read local freecam yaw/pitch/dist/fp + FOV.
   */
  tickLeaderCam(sample: () => FollowCamState | null): void {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session || !session.focusActive || session.sessionId !== this.leadingSessionId) return
    const now = Date.now()
    if (now - this.lastCamSentAt < CAM_PUBLISH_INTERVAL_MS) return
    const raw = sample()
    if (!raw) return
    const cam = quantizeFollowCam(raw)
    // Always send first packet after focus-on; then skip identical snapshots.
    if (this.lastPublishedCam && followCamEqual(this.lastPublishedCam, cam) && now - this.lastCamSentAt < 500) {
      return
    }
    this.lastCamSentAt = now
    this.lastPublishedCam = cam
    session.lastCam = cam
    this.sessions.set(id, session)
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    void this.publish(id, {
      t: 'cam',
      s: session.sessionId,
      l: local,
      at: now,
      fp: cam.fp,
      yaw: cam.yaw,
      pitch: cam.pitch,
      dist: cam.dist,
      fov: cam.fov
    })
  }

  getActiveFlag(): {
    communityId: string
    sessionId: string
    leaderAddress: string
    flagDataUrl: string | null
  } | null {
    // Prefer the tour we're leading or following; else any session with a flag.
    const prefer =
      this.leadingCommunityId ||
      this.followingCommunityId ||
      null
    if (prefer) {
      const s = this.sessions.get(prefer)
      if (s) {
        return {
          communityId: s.communityId,
          sessionId: s.sessionId,
          leaderAddress: s.leaderAddress,
          flagDataUrl: s.flagDataUrl
        }
      }
    }
    for (const s of this.sessions.values()) {
      if (s.flagDataUrl) {
        return {
          communityId: s.communityId,
          sessionId: s.sessionId,
          leaderAddress: s.leaderAddress,
          flagDataUrl: s.flagDataUrl
        }
      }
    }
    return null
  }

  /**
   * Soft feet/parcel tracking while leading a tour.
   * Updates lastTarget for the Follow bar label only — does **not** publish goto
   * and does **not** reload followers. (Auto-pilot movement is a later feature.)
   */
  noteLeaderLocation(route: RouteTarget): void {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return
    const target = routeToFollowTarget(route)
    if (!target) return
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session || session.sessionId !== this.leadingSessionId) return
    if (followTargetsEqual(session.lastTarget, target)) return

    session.lastTarget = target
    this.sessions.set(id, session)
    this.persistLeaderResumeIfLeading()
    this.emit({ kind: 'changed' })
  }

  /**
   * Hard leader navigation — intentional /goto or Jump In while leading.
   * Publishes a goto pulse so followers teleport. Soft walk must use noteLeaderLocation.
   *
   * @deprecated Prefer noteLeaderGoto / noteLeaderLocation. Kept for call sites that pass hard=true via options.
   */
  noteLeaderNavigation(route: RouteTarget, opts?: { hard?: boolean }): void {
    if (opts?.hard === false) {
      this.noteLeaderLocation(route)
      return
    }
    // Default: treat as hard goto (explicit Jump In / /goto call sites).
    this.noteLeaderGoto(route)
  }

  /**
   * Hard /goto: update label + publish goto so followers jump (rate-limited).
   * Compares against last *published* hard stop — not soft label updates.
   */
  noteLeaderGoto(route: RouteTarget): void {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return
    const target = routeToFollowTarget(route)
    if (!target) return
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session || session.sessionId !== this.leadingSessionId) return

    // Always refresh local label.
    session.lastTarget = target
    this.sessions.set(id, session)
    this.persistLeaderResumeIfLeading()
    this.emit({ kind: 'changed' })

    // Skip wire only if we already published this exact hard stop recently.
    if (
      followTargetsEqual(this.lastPublishedGoto, target) &&
      Date.now() - this.lastGotoSentAt < GOTO_MIN_INTERVAL_MS
    ) {
      return
    }

    const now = Date.now()
    const wait = GOTO_MIN_INTERVAL_MS - (now - this.lastGotoSentAt)
    if (wait > 0) {
      this.pendingGotoTarget = target
      if (!this.pendingGotoTimer) {
        this.pendingGotoTimer = window.setTimeout(() => {
          this.pendingGotoTimer = 0
          const pending = this.pendingGotoTarget
          this.pendingGotoTarget = null
          if (pending) this.flushLeaderGoto(pending)
        }, wait)
      }
      return
    }

    this.flushLeaderGoto(target)
  }

  private flushLeaderGoto(target: FollowTarget): void {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session || session.sessionId !== this.leadingSessionId) return

    // Prefer newest pending if multiple hard gotos arrived during the wait.
    const finalTarget = this.pendingGotoTarget ?? target
    this.pendingGotoTarget = null
    this.clearPendingGoto()

    // Already on the wire for this stop — still refresh label, skip republish.
    if (followTargetsEqual(this.lastPublishedGoto, finalTarget)) {
      session.lastTarget = finalTarget
      this.sessions.set(id, session)
      this.emit({ kind: 'changed' })
      return
    }

    session.lastTarget = finalTarget
    this.sessions.set(id, session)
    this.lastGotoSentAt = Date.now()
    this.lastPublishedGoto = finalTarget
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    void this.publish(id, {
      t: 'goto',
      s: session.sessionId,
      l: local,
      at: this.lastGotoSentAt,
      target: finalTarget
    })
    this.emit({ kind: 'changed' })
    clientDebugLog.log(
      'social',
      `Follow /goto pulse → ${followTargetLabel(finalTarget)}`,
      { level: 'info', alsoConsole: true }
    )
  }

  private clearPendingGoto(): void {
    if (this.pendingGotoTimer) {
      window.clearTimeout(this.pendingGotoTimer)
      this.pendingGotoTimer = 0
    }
    this.pendingGotoTarget = null
  }

  /** Inbound control message from community topic (already membership-filtered). */
  handleRemote(communityId: string, fromAddress: string, msg: FollowWireMsg): void {
    if (this.disposed) return
    const id = communityId.trim().toLowerCase()
    const from = fromAddress.trim().toLowerCase()
    if (!id || !from) return
    // Prefer wire leader field; fall back to packet sender.
    const leader = (msg.l || from).toLowerCase()
    const local = this.getLocalAddress()?.toLowerCase() ?? ''

    if (msg.t === 'start' || msg.t === 'hb') {
      this.applyLeadAnnounce(
        id,
        leader,
        msg.s,
        msg.at,
        msg.target,
        msg.t === 'hb',
        local,
        'flag' in msg ? msg.flag : undefined,
        'focus' in msg ? msg.focus : undefined,
        'locations' in msg ? msg.locations : undefined
      )
      // Re-announce presence so leader roster recovers after reload / late hb.
      if (
        msg.t === 'hb' &&
        this.followingCommunityId === id &&
        this.followingSessionId === msg.s &&
        local &&
        ADDR_RE.test(local)
      ) {
        void this.publish(id, { t: 'join', s: msg.s, l: local, at: Date.now() })
      }
      return
    }
    if (msg.t === 'stop') {
      this.applyStop(id, leader, msg.s, local)
      return
    }
    if (msg.t === 'loc') {
      this.applyLocations(id, msg.s, leader, msg.locations)
      return
    }
    if (msg.t === 'goto') {
      this.applyGoto(id, leader, msg.s, msg.target, local)
      return
    }
    if (msg.t === 'flag') {
      this.applyFlag(id, leader, msg.s, msg.flag, local)
      return
    }
    if (msg.t === 'focus') {
      this.applyFocus(id, leader, msg.s, msg.on, local)
      return
    }
    if (msg.t === 'cam') {
      this.applyCam(
        id,
        leader,
        msg.s,
        { fp: msg.fp, yaw: msg.yaw, pitch: msg.pitch, dist: msg.dist, fov: msg.fov },
        local
      )
      return
    }
    if (msg.t === 'join') {
      // `l` is the follower address (or fall back to packet sender).
      this.applyFollowerJoin(id, msg.s, (msg.l || from).toLowerCase())
      return
    }
    if (msg.t === 'leave') {
      this.applyFollowerLeave(id, msg.s, (msg.l || from).toLowerCase())
    }
  }

  private applyFollowerJoin(communityId: string, sessionId: string, follower: string): void {
    if (!ADDR_RE.test(follower)) return
    const session = this.sessions.get(communityId)
    if (!session || session.sessionId !== sessionId) return
    if (follower === session.leaderAddress) return
    if (session.followerAddresses.includes(follower)) return
    session.followerAddresses = [...session.followerAddresses, follower]
    this.sessions.set(communityId, session)
    this.emit({ kind: 'changed' })
  }

  private applyFollowerLeave(communityId: string, sessionId: string, follower: string): void {
    const session = this.sessions.get(communityId)
    if (!session || session.sessionId !== sessionId) return
    const next = session.followerAddresses.filter((a) => a !== follower)
    if (next.length === session.followerAddresses.length) return
    session.followerAddresses = next
    this.sessions.set(communityId, session)
    this.emit({ kind: 'changed' })
  }

  private applyLeadAnnounce(
    communityId: string,
    leader: string,
    sessionId: string,
    at: number,
    target: FollowTarget | undefined,
    fromHeartbeat: boolean,
    local: string,
    flag?: string | null,
    focus?: boolean,
    locations?: TourLocationWire[]
  ): void {
    const existing = this.sessions.get(communityId)
    if (existing) {
      // One leader: ignore competing sessions from a different wallet.
      if (existing.leaderAddress !== leader && existing.sessionId !== sessionId) {
        return
      }
    }

    const isNew = !existing || existing.sessionId !== sessionId
    const prevFlag = existing?.sessionId === sessionId ? existing.flagDataUrl : null
    const nextFlag = flag !== undefined ? flag : prevFlag
    const prevFocus = existing?.sessionId === sessionId ? existing.focusActive : false
    const nextFocus = focus !== undefined ? focus : prevFocus
    const nextLocations =
      locations !== undefined
        ? locations.slice(0, TOUR_LOCATIONS_WIRE_CAP)
        : existing && existing.sessionId === sessionId
          ? existing.locations
          : []
    const wasAway = Boolean(existing && existing.sessionId === sessionId && existing.leaderAway)
    const now = Date.now()
    const session: CommunityTourSession = {
      communityId,
      sessionId,
      leaderAddress: leader,
      lastTarget: target ?? existing?.lastTarget ?? null,
      startedAt: existing && existing.sessionId === sessionId ? existing.startedAt : at,
      flagDataUrl: nextFlag,
      followerAddresses:
        existing && existing.sessionId === sessionId ? [...existing.followerAddresses] : [],
      focusActive: nextFocus,
      lastCam: existing && existing.sessionId === sessionId ? existing.lastCam : null,
      locations: nextLocations,
      locationEnteredAt:
        existing && existing.sessionId === sessionId ? existing.locationEnteredAt : null,
      lastLeaderSeenAt: now,
      leaderAway: false
    }
    if (target) session.lastTarget = target
    this.sessions.set(communityId, session)

    if (wasAway && !session.leaderAway) {
      this.emit({
        kind: 'leader_back',
        communityId,
        sessionId,
        leaderAddress: leader
      })
    }

    if (nextFlag !== prevFlag) {
      this.emit({
        kind: 'flag_changed',
        communityId,
        sessionId,
        leaderAddress: leader,
        flagDataUrl: nextFlag
      })
    }

    if (nextFocus !== prevFocus) {
      this.emit({
        kind: 'focus_changed',
        communityId,
        sessionId,
        leaderAddress: leader,
        focusActive: nextFocus
      })
    }

    // If we thought we were leading but someone else took over (shouldn't) — drop local lead.
    if (this.leadingCommunityId === communityId && leader !== local) {
      this.clearLocalLead()
    }

    // Drop follow if session id changed.
    if (
      this.followingCommunityId === communityId &&
      this.followingSessionId &&
      this.followingSessionId !== sessionId
    ) {
      this.followingSessionId = sessionId
    }

    const isLocalLeader = Boolean(local && leader === local)
    if (isNew && !isLocalLeader && !this.toastedSessions.has(sessionId)) {
      this.toastedSessions.add(sessionId)
      this.emit({
        kind: 'tour_started',
        communityId,
        session,
        isLocalLeader: false,
        lateJoin: fromHeartbeat
      })
    } else if (
      fromHeartbeat &&
      !isLocalLeader &&
      !this.toastedSessions.has(sessionId)
    ) {
      this.toastedSessions.add(sessionId)
      this.emit({
        kind: 'tour_started',
        communityId,
        session,
        isLocalLeader: false,
        lateJoin: true
      })
    }

    // Heartbeat is announcement + label sync only.
    // Do NOT follow_goto here — soft location changes would reload followers every parcel.
    // Hard jumps use wire t:'goto' → applyGoto. First opt-in uses follow() once.

    this.emit({ kind: 'changed' })
  }

  private applyStop(communityId: string, leader: string, sessionId: string, local: string): void {
    const existing = this.sessions.get(communityId)
    if (!existing) return
    if (existing.sessionId !== sessionId && existing.leaderAddress !== leader) return

    const hadFlag = Boolean(existing.flagDataUrl)
    const hadFocus = Boolean(existing.focusActive)
    this.sessions.delete(communityId)
    // Drop resume snapshot if this was our tour (remote stop or force-end).
    const resume = loadTourLeaderResume(local || this.getLocalAddress())
    if (resume && resume.sessionId === sessionId && resume.communityId === communityId) {
      clearTourLeaderResume()
    }
    if (this.leadingCommunityId === communityId) this.clearLocalLead()
    if (this.followingCommunityId === communityId) {
      this.followingCommunityId = null
      this.followingSessionId = null
    }
    if (hadFlag) {
      this.emit({
        kind: 'flag_changed',
        communityId,
        sessionId: existing.sessionId,
        leaderAddress: existing.leaderAddress,
        flagDataUrl: null
      })
    }
    if (hadFocus) {
      this.emit({
        kind: 'focus_changed',
        communityId,
        sessionId: existing.sessionId,
        leaderAddress: existing.leaderAddress,
        focusActive: false
      })
    }
    this.emit({ kind: 'tour_ended', communityId, sessionId: existing.sessionId })
    this.emit({ kind: 'changed' })
    void local
  }

  private applyFlag(
    communityId: string,
    leader: string,
    sessionId: string,
    flag: string | null,
    local: string
  ): void {
    const existing = this.sessions.get(communityId)
    const session: CommunityTourSession =
      existing && existing.sessionId === sessionId
        ? { ...existing, leaderAddress: leader, flagDataUrl: flag }
        : softSessionShell(communityId, sessionId, leader, {
            lastTarget: existing?.lastTarget ?? null,
            flagDataUrl: flag,
            followerAddresses: existing?.followerAddresses ? [...existing.followerAddresses] : [],
            focusActive: existing?.focusActive ?? false,
            lastCam: existing?.lastCam ?? null,
            locations: existing?.locations ? [...existing.locations] : [],
            locationEnteredAt: existing?.locationEnteredAt ?? null
          })
    if (existing && existing.leaderAddress !== leader && existing.sessionId !== sessionId) {
      return
    }
    // Only the tour leader may set the flag.
    if (existing && existing.leaderAddress !== leader && existing.sessionId === sessionId) {
      return
    }
    this.sessions.set(communityId, session)
    if (local && leader === local && this.leadingCommunityId === communityId) {
      // Echo of our own publish — still update UI.
    }
    this.emit({
      kind: 'flag_changed',
      communityId,
      sessionId,
      leaderAddress: leader,
      flagDataUrl: flag
    })
    this.emit({ kind: 'changed' })
  }

  private applyFocus(
    communityId: string,
    leader: string,
    sessionId: string,
    on: boolean,
    local: string
  ): void {
    const existing = this.sessions.get(communityId)
    if (existing && existing.leaderAddress !== leader && existing.sessionId !== sessionId) {
      return
    }
    // Only the tour leader may toggle focus.
    if (existing && existing.leaderAddress !== leader) return

    const session: CommunityTourSession =
      existing && existing.sessionId === sessionId
        ? {
            ...existing,
            leaderAddress: leader,
            focusActive: on,
            lastCam: on ? existing.lastCam : null
          }
        : softSessionShell(communityId, sessionId, leader, {
            lastTarget: existing?.lastTarget ?? null,
            flagDataUrl: existing?.flagDataUrl ?? null,
            followerAddresses: existing?.followerAddresses ? [...existing.followerAddresses] : [],
            focusActive: on,
            lastCam: null,
            locations: existing?.locations ? [...existing.locations] : [],
            locationEnteredAt: existing?.locationEnteredAt ?? null
          })
    this.sessions.set(communityId, session)

    // Ignore echo of our own leader publish for focus_changed (UI already updated).
    const isLocalLeader = Boolean(local && leader === local && this.leadingCommunityId === communityId)
    if (!isLocalLeader || existing?.focusActive !== on) {
      this.emit({
        kind: 'focus_changed',
        communityId,
        sessionId,
        leaderAddress: leader,
        focusActive: on
      })
    }
    this.emit({ kind: 'changed' })
  }

  private applyCam(
    communityId: string,
    leader: string,
    sessionId: string,
    cam: FollowCamState,
    local: string
  ): void {
    const existing = this.sessions.get(communityId)
    if (existing && existing.leaderAddress !== leader && existing.sessionId !== sessionId) {
      return
    }
    if (existing && existing.leaderAddress !== leader) return

    const session: CommunityTourSession =
      existing && existing.sessionId === sessionId
        ? { ...existing, leaderAddress: leader, lastCam: cam, focusActive: true }
        : softSessionShell(communityId, sessionId, leader, {
            lastTarget: existing?.lastTarget ?? null,
            flagDataUrl: existing?.flagDataUrl ?? null,
            followerAddresses: existing?.followerAddresses ? [...existing.followerAddresses] : [],
            focusActive: true,
            lastCam: cam,
            locations: existing?.locations ? [...existing.locations] : [],
            locationEnteredAt: existing?.locationEnteredAt ?? null
          })
    const focusJustOn = !existing?.focusActive
    this.sessions.set(communityId, session)

    // Echo of our own leader cam stream — skip follower apply.
    if (local && leader === local) return

    if (
      this.followingCommunityId === communityId &&
      (this.followingSessionId === sessionId || !this.followingSessionId)
    ) {
      if (!this.followingSessionId) this.followingSessionId = sessionId
      if (focusJustOn) {
        this.emit({
          kind: 'focus_changed',
          communityId,
          sessionId,
          leaderAddress: leader,
          focusActive: true
        })
      }
      this.emit({
        kind: 'cam_update',
        communityId,
        sessionId,
        leaderAddress: leader,
        cam
      })
    }
  }

  private applyGoto(
    communityId: string,
    leader: string,
    sessionId: string,
    target: FollowTarget,
    local: string
  ): void {
    const existing = this.sessions.get(communityId)
    // Accept goto even if start was missed — create soft session.
    const session: CommunityTourSession = existing && existing.sessionId === sessionId
      ? {
          ...existing,
          lastTarget: target,
          leaderAddress: leader,
          lastLeaderSeenAt: Date.now(),
          leaderAway: false
        }
      : softSessionShell(communityId, sessionId, leader, {
          lastTarget: target,
          flagDataUrl: existing?.flagDataUrl ?? null,
          followerAddresses: existing?.followerAddresses ? [...existing.followerAddresses] : [],
          focusActive: existing?.focusActive ?? false,
          lastCam: existing?.lastCam ?? null,
          locations: existing?.locations ? [...existing.locations] : [],
          locationEnteredAt: existing?.locationEnteredAt ?? null
        })

    if (existing && existing.leaderAddress !== leader && existing.sessionId !== sessionId) {
      return
    }

    this.sessions.set(communityId, session)

    if (
      this.followingCommunityId === communityId &&
      this.followingSessionId === sessionId &&
      local !== leader
    ) {
      this.emit({
        kind: 'follow_goto',
        communityId,
        target,
        sessionId
      })
    } else if (
      this.followingCommunityId === communityId &&
      !this.followingSessionId
    ) {
      this.followingSessionId = sessionId
      this.emit({ kind: 'follow_goto', communityId, target, sessionId })
    }

    this.emit({ kind: 'changed' })
  }

  private clearLocalLead(): void {
    this.leadingCommunityId = null
    this.leadingSessionId = null
    this.lastPublishedGoto = null
    this.lastPublishedCam = null
    this.lastCamSentAt = 0
    this.stopHeartbeat()
    this.clearPendingGoto()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      void this.sendHeartbeat()
    }, HEARTBEAT_MS)
    // Immediate hb so resume/rejoin is visible before the first interval.
    void this.sendHeartbeat()
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = 0
  }

  private startLeaseWatch(): void {
    this.stopLeaseWatch()
    this.leaseTimer = window.setInterval(() => this.tickLeaderLease(), LEASE_TICK_MS)
  }

  private stopLeaseWatch(): void {
    if (this.leaseTimer) window.clearInterval(this.leaseTimer)
    this.leaseTimer = 0
  }

  /**
   * Follower-side lease: mark leader away after missed heartbeats; force-end after 5 min.
   */
  private tickLeaderLease(): void {
    if (this.disposed) return
    const now = Date.now()
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    for (const [communityId, session] of [...this.sessions]) {
      // Local leader is always "seen".
      if (local && session.leaderAddress === local && this.leadingSessionId === session.sessionId) {
        session.lastLeaderSeenAt = now
        session.leaderAway = false
        this.sessions.set(communityId, session)
        continue
      }
      const silentMs = now - (session.lastLeaderSeenAt || session.startedAt)
      if (silentMs >= LEADER_FORCE_END_MS) {
        clientDebugLog.log(
          'social',
          `Tour force-ended — no leader for ${Math.round(silentMs / 1000)}s · ${communityId.slice(0, 8)}…`,
          { level: 'warn', alsoConsole: true }
        )
        // Local end (no stop wire from a non-leader). Everyone who times out ends cleanly.
        this.forceEndSessionLocal(communityId, session, 'leader_timeout')
        continue
      }
      if (silentMs >= LEADER_AWAY_AFTER_MS && !session.leaderAway) {
        session.leaderAway = true
        this.sessions.set(communityId, session)
        this.emit({
          kind: 'leader_away',
          communityId,
          sessionId: session.sessionId,
          leaderAddress: session.leaderAddress,
          forceEndInMs: Math.max(0, LEADER_FORCE_END_MS - silentMs)
        })
        this.emit({ kind: 'changed' })
      }
    }
  }

  private forceEndSessionLocal(
    communityId: string,
    session: CommunityTourSession,
    _reason: string
  ): void {
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    this.applyStop(communityId, session.leaderAddress, session.sessionId, local)
    if (
      this.leadingCommunityId === communityId &&
      this.leadingSessionId === session.sessionId
    ) {
      this.clearLocalLead()
      clearTourLeaderResume()
    }
  }

  private persistLeaderResumeIfLeading(): void {
    if (!this.leadingCommunityId || !this.leadingSessionId) return
    const session = this.sessions.get(this.leadingCommunityId)
    if (!session || session.sessionId !== this.leadingSessionId) return
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    saveTourLeaderResume({
      communityId: session.communityId,
      sessionId: session.sessionId,
      leaderAddress: local,
      lastTarget: session.lastTarget,
      flagDataUrl: session.flagDataUrl,
      locations: session.locations.slice(0, TOUR_LOCATIONS_WIRE_CAP),
      startedAt: session.startedAt,
      savedAt: Date.now()
    })
  }

  /** Best-effort leave when the tab closes while following. */
  private bestEffortFollowerLeave(): void {
    const id = this.followingCommunityId
    const sessionId = this.followingSessionId
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    if (!id || !sessionId || !local || !ADDR_RE.test(local)) return
    void this.publish(id, { t: 'leave', s: sessionId, l: local, at: Date.now() })
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session) return
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    session.lastLeaderSeenAt = Date.now()
    session.leaderAway = false
    this.sessions.set(id, session)
    this.persistLeaderResumeIfLeading()
    const msg: FollowWireMsg = {
      t: 'hb',
      s: session.sessionId,
      l: local,
      at: Date.now(),
      ...(session.lastTarget ? { target: session.lastTarget } : {}),
      // Rebroadcast flag so late joiners get the banner without a separate request.
      ...(session.flagDataUrl ? { flag: session.flagDataUrl } : {}),
      // Late joiners learn Focus is on (cam stream fills in shortly after).
      focus: session.focusActive,
      ...(session.locations.length ? { locations: session.locations.slice(0, TOUR_LOCATIONS_WIRE_CAP) } : {})
    }
    await this.publish(id, msg)
  }

  /** Leader: pin current place as a tour stop. */
  async addLocation(input: {
    target: FollowTarget
    sceneName: string
    name?: string
  }): Promise<TourLocationWire | null> {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return null
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session || session.sessionId !== this.leadingSessionId) return null
    if (session.locations.length >= TOUR_LOCATIONS_WIRE_CAP) {
      clientDebugLog.log('social', 'Tour location cap reached', { level: 'warn' })
      return null
    }
    const now = Date.now()
    this.finalizeCurrentLocationDwell(session, now)
    const people = 1 + session.followerAddresses.length
    const loc: TourLocationWire = {
      id: newTourLocationId(),
      at: now,
      target: input.target,
      sceneName: input.sceneName.trim() || followTargetLabel(input.target) || 'Scene',
      people,
      ...(input.name?.trim() ? { name: input.name.trim().slice(0, 80) } : {})
    }
    session.locations = [...session.locations, loc]
    session.locationEnteredAt = now
    this.sessions.set(id, session)
    await this.publishLocations(session)
    this.emit({ kind: 'changed' })
    return loc
  }

  async renameLocation(locationId: string, name: string): Promise<boolean> {
    const session = this.getLeadingSession()
    if (!session) return false
    const idx = session.locations.findIndex((l) => l.id === locationId)
    if (idx < 0) return false
    const next = [...session.locations]
    const trimmed = name.trim().slice(0, 80)
    const cur = next[idx]!
    next[idx] = trimmed
      ? { ...cur, name: trimmed }
      : { id: cur.id, at: cur.at, target: cur.target, sceneName: cur.sceneName, people: cur.people, dwellSec: cur.dwellSec }
    session.locations = next
    this.sessions.set(session.communityId, session)
    await this.publishLocations(session)
    this.emit({ kind: 'changed' })
    return true
  }

  async removeLocation(locationId: string): Promise<boolean> {
    const session = this.getLeadingSession()
    if (!session) return false
    const next = session.locations.filter((l) => l.id !== locationId)
    if (next.length === session.locations.length) return false
    session.locations = next
    if (session.locations.length === 0) session.locationEnteredAt = null
    this.sessions.set(session.communityId, session)
    await this.publishLocations(session)
    this.emit({ kind: 'changed' })
    return true
  }

  /** Finalize dwell on last stop (call before end tour export). */
  finalizeTourDwell(): TourLocationWire[] {
    const session = this.getLeadingSession()
    if (!session) return []
    this.finalizeCurrentLocationDwell(session, Date.now())
    this.sessions.set(session.communityId, session)
    return session.locations.map((l) => ({ ...l }))
  }

  getLocations(communityId?: string): TourLocationWire[] {
    if (communityId) {
      return [...(this.sessions.get(communityId.trim().toLowerCase())?.locations ?? [])]
    }
    const lead = this.getLeadingSession()
    if (lead) return [...lead.locations]
    if (this.followingCommunityId) {
      return [...(this.sessions.get(this.followingCommunityId)?.locations ?? [])]
    }
    return []
  }

  private getLeadingSession(): CommunityTourSession | null {
    if (!this.leadingCommunityId || !this.leadingSessionId) return null
    const s = this.sessions.get(this.leadingCommunityId)
    if (!s || s.sessionId !== this.leadingSessionId) return null
    return s
  }

  private finalizeCurrentLocationDwell(session: CommunityTourSession, now: number): void {
    if (!session.locations.length || session.locationEnteredAt == null) return
    const last = session.locations[session.locations.length - 1]
    if (!last) return
    const dwell = Math.max(0, Math.round((now - session.locationEnteredAt) / 1000))
    session.locations = [
      ...session.locations.slice(0, -1),
      { ...last, dwellSec: (last.dwellSec ?? 0) + dwell }
    ]
    session.locationEnteredAt = null
  }

  private async publishLocations(session: CommunityTourSession): Promise<void> {
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    await this.publish(session.communityId, {
      t: 'loc',
      s: session.sessionId,
      l: local,
      at: Date.now(),
      locations: session.locations.slice(0, TOUR_LOCATIONS_WIRE_CAP)
    })
  }

  private applyLocations(
    communityId: string,
    sessionId: string,
    leader: string,
    locations: TourLocationWire[]
  ): void {
    const existing = this.sessions.get(communityId)
    if (existing && existing.sessionId !== sessionId) return
    if (existing && existing.leaderAddress !== leader) return
    const session: CommunityTourSession = existing
      ? {
          ...existing,
          locations: locations.slice(0, TOUR_LOCATIONS_WIRE_CAP)
        }
      : softSessionShell(communityId, sessionId, leader, {
          locations: locations.slice(0, TOUR_LOCATIONS_WIRE_CAP)
        })
    this.sessions.set(communityId, session)
    this.emit({ kind: 'changed' })
  }

  private emit(ev: CommunityFollowEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(ev)
      } catch (err) {
        console.warn('[follow] listener error', err)
      }
    }
  }
}

const ADDR_RE = /^0x[a-f0-9]{40}$/

/** Incomplete session created from a late wire message (flag/goto/cam before start). */
function softSessionShell(
  communityId: string,
  sessionId: string,
  leader: string,
  partial: Partial<CommunityTourSession> = {}
): CommunityTourSession {
  const now = Date.now()
  return {
    communityId,
    sessionId,
    leaderAddress: leader,
    lastTarget: partial.lastTarget ?? null,
    startedAt: partial.startedAt ?? now,
    flagDataUrl: partial.flagDataUrl ?? null,
    followerAddresses: partial.followerAddresses ? [...partial.followerAddresses] : [],
    focusActive: partial.focusActive ?? false,
    lastCam: partial.lastCam ?? null,
    locations: partial.locations ? [...partial.locations] : [],
    locationEnteredAt: partial.locationEnteredAt ?? null,
    lastLeaderSeenAt: partial.lastLeaderSeenAt ?? now,
    leaderAway: partial.leaderAway ?? false
  }
}
