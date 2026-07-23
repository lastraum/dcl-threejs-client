/**
 * Session-only community Follow / Tour state (one leader per community).
 *
 * - Mods/owners start a tour (Lead)
 * - Members opt in via Follow in community chat
 * - Follow = hard /goto only: leader intentional jumps emit goto pulses; followers jump
 * - Soft parcel walk only updates lastTarget for UI labels (no wire goto, no reload)
 * - Auto-pilot (buffer-follow leader feet) is a separate future mode — not this path
 * - Heartbeats re-announce tour + last stop for late joiners / label sync (no jump)
 */

import { clientDebugLog } from '../client/debug/ClientDebugLog'
import type { RouteTarget } from '../dcl/content/route'
import {
  canPostCommunityAnnouncements
} from './communityPermissions'
import {
  followTargetLabel,
  followTargetsEqual,
  newFollowSessionId,
  routeToFollowTarget,
  type FollowTarget,
  type FollowWireMsg
} from './communityFollowWire'
import type { CommunityListRow } from './types'

const HEARTBEAT_MS = 45_000
const GOTO_MIN_INTERVAL_MS = 3_000

export type CommunityTourSession = {
  communityId: string
  sessionId: string
  leaderAddress: string
  lastTarget: FollowTarget | null
  startedAt: number
  /** Leader flag banner image (data URL), if set. */
  flagDataUrl: string | null
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
  private lastGotoSentAt = 0
  /** Last hard /goto actually published on the wire (not soft label updates). */
  private lastPublishedGoto: FollowTarget | null = null
  /** Coalesce hard /goto spam so rate-limit still flushes the latest intentional jump. */
  private pendingGotoTimer = 0
  private pendingGotoTarget: FollowTarget | null = null
  private disposed = false
  private readonly listeners = new Set<(ev: CommunityFollowEvent) => void>()

  constructor(opts: CommunityFollowControllerOptions) {
    this.publish = opts.publish
    this.getLocalAddress = opts.getLocalAddress
    this.getCommunities = opts.getCommunities
  }

  subscribe(listener: (ev: CommunityFollowEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.disposed = true
    this.stopHeartbeat()
    this.clearPendingGoto()
    this.sessions.clear()
    this.toastedSessions.clear()
    this.leadingCommunityId = null
    this.leadingSessionId = null
    this.followingCommunityId = null
    this.followingSessionId = null
    this.lastPublishedGoto = null
    this.listeners.clear()
  }

  getSession(communityId: string): CommunityTourSession | null {
    return this.sessions.get(communityId.trim().toLowerCase()) ?? null
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
   */
  async startLead(communityId: string, initialTarget?: FollowTarget | null): Promise<boolean> {
    if (this.disposed) return false
    const id = communityId.trim().toLowerCase()
    const local = this.getLocalAddress()?.toLowerCase() ?? ''
    if (!id || !local || !ADDR_RE.test(local)) return false
    if (!this.canLead(id)) {
      clientDebugLog.log('social', 'Follow tour: not allowed to lead', { level: 'warn' })
      return false
    }

    const existing = this.sessions.get(id)
    if (existing && existing.leaderAddress !== local) {
      clientDebugLog.log('social', 'Follow tour: another leader is active', { level: 'warn' })
      return false
    }

    // Stop previous local lead if switching communities.
    if (this.leadingCommunityId && this.leadingCommunityId !== id) {
      await this.stopLead()
    }

    const sessionId = existing?.sessionId && existing.leaderAddress === local
      ? existing.sessionId
      : newFollowSessionId()
    const target = initialTarget ?? existing?.lastTarget ?? null
    const session: CommunityTourSession = {
      communityId: id,
      sessionId,
      leaderAddress: local,
      lastTarget: target,
      startedAt: Date.now(),
      flagDataUrl: existing?.leaderAddress === local ? existing.flagDataUrl : null
    }

    const startMsg: FollowWireMsg = {
      t: 'start',
      s: sessionId,
      l: local,
      at: Date.now(),
      ...(target ? { target } : {}),
      ...(session.flagDataUrl ? { flag: session.flagDataUrl } : {})
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
    this.emit({
      kind: 'tour_started',
      communityId: id,
      session,
      isLocalLeader: true,
      lateJoin: false
    })
    this.emit({ kind: 'changed' })
    clientDebugLog.log(
      'social',
      `Follow tour started · community=${id.slice(0, 8)}… · target=${followTargetLabel(target) || 'none'}`,
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
      return false
    }

    const ok = await this.publish(id, { t: 'stop', s: sessionId, l: local, at: Date.now() })
    this.clearLocalLead()
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

    this.followingCommunityId = id
    this.followingSessionId = session.sessionId
    this.emit({ kind: 'changed' })
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
    this.followingCommunityId = null
    this.followingSessionId = null
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
        'flag' in msg ? msg.flag : undefined
      )
      return
    }
    if (msg.t === 'stop') {
      this.applyStop(id, leader, msg.s, local)
      return
    }
    if (msg.t === 'goto') {
      this.applyGoto(id, leader, msg.s, msg.target, local)
      return
    }
    if (msg.t === 'flag') {
      this.applyFlag(id, leader, msg.s, msg.flag, local)
    }
  }

  private applyLeadAnnounce(
    communityId: string,
    leader: string,
    sessionId: string,
    at: number,
    target: FollowTarget | undefined,
    fromHeartbeat: boolean,
    local: string,
    flag?: string | null
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
    const session: CommunityTourSession = {
      communityId,
      sessionId,
      leaderAddress: leader,
      lastTarget: target ?? existing?.lastTarget ?? null,
      startedAt: existing && existing.sessionId === sessionId ? existing.startedAt : at,
      flagDataUrl: nextFlag
    }
    if (target) session.lastTarget = target
    this.sessions.set(communityId, session)

    if (nextFlag !== prevFlag) {
      this.emit({
        kind: 'flag_changed',
        communityId,
        sessionId,
        leaderAddress: leader,
        flagDataUrl: nextFlag
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
    this.sessions.delete(communityId)
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
        : {
            communityId,
            sessionId,
            leaderAddress: leader,
            lastTarget: existing?.lastTarget ?? null,
            startedAt: existing?.startedAt ?? Date.now(),
            flagDataUrl: flag
          }
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
      ? { ...existing, lastTarget: target, leaderAddress: leader }
      : {
          communityId,
          sessionId,
          leaderAddress: leader,
          lastTarget: target,
          startedAt: Date.now(),
          flagDataUrl: existing?.flagDataUrl ?? null
        }

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
    this.stopHeartbeat()
    this.clearPendingGoto()
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    this.heartbeatTimer = window.setInterval(() => {
      void this.sendHeartbeat()
    }, HEARTBEAT_MS)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) window.clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = 0
  }

  private async sendHeartbeat(): Promise<void> {
    if (this.disposed || !this.leadingCommunityId || !this.leadingSessionId) return
    const id = this.leadingCommunityId
    const session = this.sessions.get(id)
    if (!session) return
    const local = this.getLocalAddress()?.toLowerCase() ?? session.leaderAddress
    const msg: FollowWireMsg = {
      t: 'hb',
      s: session.sessionId,
      l: local,
      at: Date.now(),
      ...(session.lastTarget ? { target: session.lastTarget } : {}),
      // Rebroadcast flag so late joiners get the banner without a separate request.
      ...(session.flagDataUrl ? { flag: session.flagDataUrl } : {})
    }
    await this.publish(id, msg)
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
