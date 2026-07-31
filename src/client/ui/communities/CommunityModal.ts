import type { AuthIdentity } from '@dcl/crypto/dist/types'
import {
  canManageCommunityVoice,
  canPostCommunityAnnouncements
} from '../../../social/communityPermissions'
import {
  getCommunityVoiceSession,
  walletFromIdentity,
  type CommunityVoiceParticipant,
  type CommunityVoiceSessionState
} from '../../../social/CommunityVoiceSession'
import { ChatPeerProfiles } from '../../../social/ChatPeerProfiles'
import { communityDisplayImageUrl } from '../../../social/communityThumbnails'
import {
  createCommunityPostSigned,
  fetchCommunityByIdPublic,
  fetchCommunityByIdSigned,
  fetchCommunityMembers,
  fetchCommunityPlaces,
  fetchCommunityPosts,
  setCommunityPostLikedSigned,
  type CommunityMemberRow,
  type CommunityPost
} from '../../../social/socialApi'
import { endCommunityVoiceChatViaSocialRpc } from '../../../social/socialServiceV2'
import { shortenAddress } from '../../../avatar/displayName'
import type { CommunityDetail, CommunityListRow } from '../../../social/types'
import type { CommunityFollowController } from '../../../social/CommunityFollowController'
import type { RouteTarget } from '../../../dcl/content/route'
import { routeToFollowTarget } from '../../../social/communityFollowWire'

export type CommunityModalOptions = {
  getAuthIdentity?: () => AuthIdentity | null
  getUserAddress?: () => string | null
  /** Open community text channel in chat dock / panel. */
  onOpenChat?: (community: CommunityDetail) => void
  /** In-play follow controller (Start tour under Voice Stream). */
  getFollow?: () => CommunityFollowController | null
  getCurrentRoute?: () => RouteTarget | null
}

export type CommunityModalOpenOptions = {
  /** After open, auto-join voice when a stream is live. */
  autoJoinVoice?: boolean
}

type TabId = 'announcements' | 'members' | 'places' | 'photos'

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function formatMemberCount(count: number | undefined): string {
  if (typeof count !== 'number' || !Number.isFinite(count)) return '— Members'
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M Members`
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k Members`
  return `${count} Member${count === 1 ? '' : 's'}`
}

function formatPostDate(iso: string): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

function linkify(text: string): string {
  return escapeHtml(text).replace(
    /(https?:\/\/[^\s<]+)/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer" class="community-modal-link">$1</a>'
  )
}

function communityShareUrl(id: string): string {
  return `${window.location.origin}/communities#${encodeURIComponent(id.trim())}`
}

function mergePreviewAndDetail(preview: CommunityListRow, detail: CommunityDetail | null): CommunityDetail {
  if (!detail) {
    return {
      id: preview.id,
      name: preview.name,
      description: preview.description?.trim() ?? '',
      thumbnails: preview.thumbnails,
      isPrivate: preview.isPrivate,
      memberCount: preview.memberCount,
      ownerAddress: preview.ownerAddress,
      ownerName: preview.ownerName,
      role: preview.role
    }
  }
  return {
    ...detail,
    thumbnails: { ...preview.thumbnails, ...detail.thumbnails },
    memberCount: detail.memberCount ?? preview.memberCount,
    isPrivate: detail.isPrivate ?? preview.isPrivate,
    ownerName: detail.ownerName ?? preview.ownerName,
    ownerAddress: detail.ownerAddress ?? preview.ownerAddress,
    role: detail.role ?? preview.role
  }
}

/**
 * Explorer-style community detail modal:
 * header · tabs (announcements / members / places / photos) · voice + events rail.
 *
 * Announcement composer + "Start voice stream" only for owner/moderator/admin
 * (dcl-companion parity). Members can still join an already-live voice stream.
 */
export class CommunityModal {
  readonly root: HTMLElement

  private readonly getAuthIdentity?: () => AuthIdentity | null
  private readonly getUserAddress?: () => string | null
  private readonly onOpenChat?: (community: CommunityDetail) => void
  private readonly getFollow?: () => CommunityFollowController | null
  private readonly getCurrentRoute?: () => RouteTarget | null
  private readonly onKeyDown: (ev: KeyboardEvent) => void
  private openGen = 0
  private disposed = false
  private current: CommunityDetail | null = null
  private tab: TabId = 'announcements'
  private posts: CommunityPost[] = []
  private members: CommunityMemberRow[] = []
  private placeIds: string[] = []
  private tabLoading = false
  private unsubFollow: (() => void) | null = null
  private unsubVoice: (() => void) | null = null
  private unsubVoiceProfiles: (() => void) | null = null
  private voiceState: CommunityVoiceSessionState | null = null
  /** Catalyst profiles for voice roster (name + face). */
  private readonly voiceProfiles = new ChatPeerProfiles()
  private voiceProfileFetchGen = 0

  private sessionAddress(): string | null {
    return this.getUserAddress?.()?.trim().toLowerCase() || null
  }

  private canPostAnnouncements(community: CommunityDetail | null = this.current): boolean {
    if (!community || !this.getAuthIdentity?.()) return false
    return canPostCommunityAnnouncements(
      community.role,
      this.sessionAddress(),
      community.ownerAddress
    )
  }

  private canStartVoice(community: CommunityDetail | null = this.current): boolean {
    if (!community || !this.getAuthIdentity?.()) return false
    return canManageCommunityVoice(community.role, this.sessionAddress(), community.ownerAddress)
  }

  constructor(opts: CommunityModalOptions = {}) {
    this.getAuthIdentity = opts.getAuthIdentity
    this.getUserAddress = opts.getUserAddress
    this.onOpenChat = opts.onOpenChat
    this.getFollow = opts.getFollow
    this.getCurrentRoute = opts.getCurrentRoute

    this.root = document.createElement('div')
    this.root.className = 'community-modal-host'
    this.root.hidden = true

    this.onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') this.close()
    }
  }

  /** Owner/mod can lead tours (same gate as announcements). */
  private canLeadTour(community: CommunityDetail | null = this.current): boolean {
    return this.canPostAnnouncements(community)
  }

  mount(): void {
    document.body.appendChild(this.root)
  }

  open(preview: CommunityListRow, opts: CommunityModalOpenOptions = {}): void {
    if (this.disposed) return
    const gen = ++this.openGen
    this.tab = 'announcements'
    this.posts = []
    this.members = []
    this.placeIds = []
    const merged = mergePreviewAndDetail(preview, null)
    this.current = merged
    this.root.hidden = false
    this.paint({ loading: true })
    document.addEventListener('keydown', this.onKeyDown)
    document.body.classList.add('community-modal-open')
    this.root.querySelector<HTMLButtonElement>('.community-modal-close')?.focus()
    void this.hydrate(preview, gen, opts)
  }

  close(): void {
    this.openGen++
    this.unsubFollow?.()
    this.unsubFollow = null
    this.unsubVoice?.()
    this.unsubVoice = null
    this.unsubVoiceProfiles?.()
    this.unsubVoiceProfiles = null
    this.voiceState = null
    this.voiceProfileFetchGen++
    this.root.hidden = true
    this.root.innerHTML = ''
    this.current = null
    document.removeEventListener('keydown', this.onKeyDown)
    document.body.classList.remove('community-modal-open')
  }

  dispose(): void {
    this.disposed = true
    this.close()
    this.voiceProfiles.clear()
    this.root.remove()
  }

  private wireVoiceSession(): void {
    this.unsubVoice?.()
    this.unsubVoiceProfiles?.()
    this.unsubVoiceProfiles = this.voiceProfiles.onUpdate(() => {
      if (this.disposed || this.root.hidden) return
      this.refreshVoicePanel()
    })
    this.unsubVoice = getCommunityVoiceSession().subscribe((state) => {
      if (this.disposed || this.root.hidden) return
      this.voiceState = state
      void this.ensureVoiceProfiles(state.participants)
      this.refreshVoicePanel()
    })
  }

  private async ensureVoiceProfiles(participants: CommunityVoiceParticipant[]): Promise<void> {
    const gen = ++this.voiceProfileFetchGen
    const wallets = participants
      .map((p) => p.wallet ?? walletFromIdentity(p.identity))
      .filter((w): w is string => !!w)
    await Promise.all(wallets.map((w) => this.voiceProfiles.ensurePeer(w, { fast: true })))
    if (gen !== this.voiceProfileFetchGen || this.disposed) return
    this.refreshVoicePanel()
  }

  private refreshVoicePanel(): void {
    const host = this.root.querySelector('[data-community-voice-panel]') as HTMLElement | null
    if (!host || !this.current) return
    host.innerHTML = this.renderVoicePanel(this.current)
    this.bindVoicePanel(this.current)
  }

  /** Refresh tour CTA if follow state changes while modal is open. */
  private wireFollowUi(): void {
    this.unsubFollow?.()
    this.unsubFollow = null
    const follow = this.getFollow?.()
    if (!follow) return
    this.unsubFollow = follow.subscribe(() => {
      if (this.disposed || this.root.hidden || !this.current) return
      this.refreshTourCta()
    })
  }

  private refreshTourCta(): void {
    const host = this.root.querySelector('[data-community-tour-slot]') as HTMLElement | null
    if (!host || !this.current) return
    host.innerHTML = this.renderTourCta(this.current)
    this.bindTourCta()
  }

  private paint(opts: { loading?: boolean; detailError?: string | null } = {}): void {
    if (!this.current) return
    this.root.innerHTML = this.renderShell(this.current, opts)
    this.wireChrome(this.current)
    this.renderActiveTab()
  }

  private async hydrate(
    preview: CommunityListRow,
    gen: number,
    opts: CommunityModalOpenOptions = {}
  ): Promise<void> {
    const identity = this.getAuthIdentity?.() ?? null
    let detail: CommunityDetail | null = null
    let detailError: string | null = null
    try {
      detail = identity
        ? await fetchCommunityByIdSigned(identity, preview.id)
        : await fetchCommunityByIdPublic(preview.id)
      if (!detail) detailError = 'Could not load community details'
    } catch (err) {
      detailError = err instanceof Error ? err.message : 'Could not load community details'
    }
    if (this.disposed || this.root.hidden || gen !== this.openGen) return

    this.current = mergePreviewAndDetail(preview, detail)
    this.paint({ loading: false, detailError })
    this.wireVoiceSession()
    void this.loadTabData(gen)

    // Voice toast / live CTA — join even if detail flag is slightly stale.
    if (opts.autoJoinVoice) {
      void this.joinCommunityVoice({ ...this.current, voiceChatActive: true })
    }
  }

  private async loadTabData(gen: number): Promise<void> {
    if (!this.current) return
    const id = this.current.id
    const identity = this.getAuthIdentity?.() ?? null
    this.tabLoading = true
    this.renderActiveTab()

    try {
      if (this.tab === 'announcements') {
        const { posts } = await fetchCommunityPosts(id, { identity, limit: 40 })
        if (gen !== this.openGen) return
        this.posts = posts
      } else if (this.tab === 'members') {
        const { members } = await fetchCommunityMembers(id, { identity, limit: 80 })
        if (gen !== this.openGen) return
        this.members = members
      } else if (this.tab === 'places') {
        const { placeIds } = await fetchCommunityPlaces(id, { identity })
        if (gen !== this.openGen) return
        this.placeIds = placeIds
      }
    } catch {
      /* tab body shows empty/error via empty lists */
    }

    if (gen !== this.openGen) return
    this.tabLoading = false
    this.renderActiveTab()
  }

  private setTab(tab: TabId): void {
    if (this.tab === tab || !this.current) return
    this.tab = tab
    for (const btn of this.root.querySelectorAll<HTMLElement>('[data-tab]')) {
      btn.classList.toggle('is-active', btn.dataset.tab === tab)
    }
    void this.loadTabData(this.openGen)
  }

  private wireChrome(merged: CommunityDetail): void {
    this.root.querySelector('.community-modal-backdrop')?.addEventListener('click', () => this.close())
    this.root.querySelector('.community-modal-panel')?.addEventListener('click', (e) => e.stopPropagation())
    this.root.querySelector('.community-modal-close')?.addEventListener('click', () => this.close())
    this.root.querySelector('[data-community-copy]')?.addEventListener('click', () => {
      void navigator.clipboard?.writeText(communityShareUrl(merged.id))
    })
    this.root.querySelector('[data-community-chat]')?.addEventListener('click', () => {
      if (this.onOpenChat && this.current) {
        this.onOpenChat(this.current)
        this.close()
      } else {
        void navigator.clipboard?.writeText(communityShareUrl(merged.id))
      }
    })
    this.bindVoicePanel(merged)
    this.bindTourCta()
    this.wireFollowUi()
    for (const tabBtn of this.root.querySelectorAll<HTMLElement>('[data-tab]')) {
      tabBtn.addEventListener('click', () => {
        const t = tabBtn.dataset.tab as TabId | undefined
        if (t) this.setTab(t)
      })
    }
  }

  private bindTourCta(): void {
    this.root.querySelector('[data-community-tour-start]')?.addEventListener('click', () => {
      void this.onTourStartClick()
    })
    this.root.querySelector('[data-community-tour-follow]')?.addEventListener('click', () => {
      this.onTourFollowClick()
    })
    this.root.querySelector('[data-community-tour-stop]')?.addEventListener('click', () => {
      void this.onTourStopClick()
    })
    this.root.querySelector('[data-community-tour-unfollow]')?.addEventListener('click', () => {
      this.onTourUnfollowClick()
    })
  }

  private async onTourStartClick(): Promise<void> {
    const community = this.current
    const follow = this.getFollow?.()
    if (!community || !follow) return
    if (!this.canLeadTour(community)) return
    if (follow.isLeading(community.id)) return
    const btn = this.root.querySelector<HTMLButtonElement>('[data-community-tour-start]')
    if (btn) {
      btn.disabled = true
      btn.textContent = 'STARTING…'
    }
    const initial = routeToFollowTarget(this.getCurrentRoute?.() ?? null)
    const ok = await follow.startLead(community.id, initial)
    if (btn) {
      btn.disabled = false
      if (!ok) btn.title = 'Could not start tour — join the scene in play mode and try again'
    }
    this.refreshTourCta()
  }

  private onTourFollowClick(): void {
    const community = this.current
    const follow = this.getFollow?.()
    if (!community || !follow) return
    if (!follow.getSession(community.id)) return
    if (follow.isLeading(community.id) || follow.isFollowing(community.id)) return
    follow.follow(community.id)
    this.refreshTourCta()
  }

  private async onTourStopClick(): Promise<void> {
    const follow = this.getFollow?.()
    if (!follow?.isLeading()) return
    const btn = this.root.querySelector<HTMLButtonElement>('[data-community-tour-stop]')
    if (btn) btn.disabled = true
    await follow.stopLead()
    this.refreshTourCta()
  }

  private onTourUnfollowClick(): void {
    const follow = this.getFollow?.()
    if (!follow?.isFollowing()) return
    follow.unfollow()
    this.refreshTourCta()
  }

  private renderTourCta(merged: CommunityDetail): string {
    const follow = this.getFollow?.()
    const session = follow?.getSession(merged.id) ?? null
    const leading = Boolean(follow?.isLeading(merged.id))
    const following = Boolean(follow?.isFollowing(merged.id))
    const followReady = Boolean(follow)
    const canLead = this.canLeadTour(merged)

    // Active tour, local leader
    if (leading) {
      return `
        <button
          type="button"
          class="community-modal-tour-cta is-live"
          data-community-tour-stop
          title="Stop community tour"
        >● STOP TOUR</button>
        <p class="community-modal-tour-hint">Tour live — use sidebar 🚩 Tour Options for flag banner</p>`
    }

    // Active tour, already following
    if (session && following) {
      return `
        <button
          type="button"
          class="community-modal-tour-cta is-live"
          data-community-tour-unfollow
          title="Stop following this tour"
        >● STOP FOLLOWING</button>
        <p class="community-modal-tour-hint">Following the leader — /goto jumps with them</p>`
    }

    // Active tour, not the leader → Follow Tour (any member)
    if (session) {
      return `
        <button
          type="button"
          class="community-modal-tour-cta community-modal-tour-cta--follow"
          data-community-tour-follow
          ${followReady ? '' : 'disabled'}
          title="${
            followReady
              ? 'Follow this tour — jump when the leader /goto'
              : 'Jump into a scene (play mode) to follow a tour'
          }"
        >◉ FOLLOW TOUR</button>
        ${
          followReady
            ? `<p class="community-modal-tour-hint">Tour live — join the group</p>`
            : `<p class="community-modal-tour-hint">Available in play mode</p>`
        }`
    }

    // No tour — only owners/mods can start
    if (!canLead) return ''

    return `
      <button
        type="button"
        class="community-modal-tour-cta"
        data-community-tour-start
        ${followReady ? '' : 'disabled'}
        title="${
          followReady
            ? 'Start a tour — followers jump on your /goto'
            : 'Jump into a scene (play mode) to start a tour'
        }"
      >◉ START TOUR</button>
      ${
        followReady
          ? ''
          : `<p class="community-modal-tour-hint">Available in play mode</p>`
      }`
  }

  private renderActiveTab(): void {
    const host = this.root.querySelector('[data-tab-body]')
    if (!host || !this.current) return
    if (this.tabLoading) {
      host.innerHTML = `<p class="community-modal-tab-status">Loading…</p>`
      return
    }
    if (this.tab === 'announcements') host.innerHTML = this.renderAnnouncements()
    else if (this.tab === 'members') host.innerHTML = this.renderMembers()
    else if (this.tab === 'places') host.innerHTML = this.renderPlaces()
    else host.innerHTML = this.renderPhotos()
    this.wireTabBody()
  }

  private wireTabBody(): void {
    const community = this.current
    if (!community) return

    const postForm = this.root.querySelector<HTMLFormElement>('[data-post-form]')
    postForm?.addEventListener('submit', (ev) => {
      ev.preventDefault()
      void this.submitPost()
    })

    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-like]')) {
      btn.addEventListener('click', () => {
        const postId = btn.dataset.like
        if (postId) void this.toggleLike(postId, btn)
      })
    }
  }

  private async submitPost(): Promise<void> {
    const community = this.current
    const identity = this.getAuthIdentity?.() ?? null
    const input = this.root.querySelector<HTMLTextAreaElement>('[data-post-input]')
    const status = this.root.querySelector<HTMLElement>('[data-post-status]')
    if (!community || !identity || !input) return
    if (!this.canPostAnnouncements(community)) {
      if (status) status.textContent = 'Only owners, moderators, and admins can post announcements.'
      return
    }
    const text = input.value.trim()
    if (!text) return
    if (text.length > 1000) {
      if (status) status.textContent = 'Announcement must be 1000 characters or fewer.'
      return
    }
    if (status) status.textContent = 'Posting…'
    const result = await createCommunityPostSigned(identity, community.id, text)
    if (!result.ok) {
      if (status)
        status.textContent =
          result.error.includes('401') ||
          result.error.includes('403') ||
          result.error.includes('permission') ||
          result.error.includes('Forbidden')
            ? 'Only owners, moderators, and admins can post announcements.'
            : result.error
      return
    }
    input.value = ''
    if (status) status.textContent = ''
    this.posts = [result.post, ...this.posts]
    this.renderActiveTab()
  }

  private async toggleLike(postId: string, btn: HTMLButtonElement): Promise<void> {
    const community = this.current
    const identity = this.getAuthIdentity?.() ?? null
    if (!community || !identity) return
    const post = this.posts.find((p) => p.id === postId)
    if (!post) return
    const next = !post.isLikedByUser
    btn.disabled = true
    const ok = await setCommunityPostLikedSigned(identity, community.id, postId, next)
    btn.disabled = false
    if (!ok) return
    post.isLikedByUser = next
    post.likesCount = Math.max(0, post.likesCount + (next ? 1 : -1))
    this.renderActiveTab()
  }

  /** Public: join live voice (toast click / auto-join). */
  async joinCommunityVoice(merged: CommunityDetail): Promise<void> {
    const live = { ...merged, voiceChatActive: true }
    await this.toggleCommunityVoice(live)
  }

  private bindVoicePanel(merged: CommunityDetail): void {
    this.root.querySelector('[data-community-voice]')?.addEventListener('click', () => {
      void this.toggleCommunityVoice(merged)
    })
    this.root.querySelector('[data-community-voice-end]')?.addEventListener('click', () => {
      void this.endCommunityVoiceForEveryone(merged)
    })
    this.root.querySelector('[data-community-voice-hand]')?.addEventListener('click', () => {
      void this.toggleHandRaise()
    })
    this.root.querySelector('[data-community-voice-mic]')?.addEventListener('click', () => {
      void this.toggleLocalMic()
    })
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-voice-promote]')) {
      btn.addEventListener('click', () => {
        const addr = btn.dataset.voicePromote
        if (addr) void this.modPromote(addr, btn)
      })
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-voice-reject]')) {
      btn.addEventListener('click', () => {
        const addr = btn.dataset.voiceReject
        if (addr) void this.modReject(addr, btn)
      })
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-voice-demote]')) {
      btn.addEventListener('click', () => {
        const addr = btn.dataset.voiceDemote
        if (addr) void this.modDemote(addr, btn)
      })
    }
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-voice-copy-wallet]')) {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const addr = btn.dataset.voiceCopyWallet
        if (!addr) return
        void navigator.clipboard?.writeText(addr).then(
          () => {
            btn.classList.add('is-copied')
            btn.title = 'Copied!'
            window.setTimeout(() => {
              btn.classList.remove('is-copied')
              btn.title = 'Copy wallet'
            }, 1400)
          },
          () => {
            btn.title = 'Copy failed'
          }
        )
      })
    }
  }

  private async toggleHandRaise(): Promise<void> {
    const voice = getCommunityVoiceSession()
    if (!voice.isActive()) return
    const next = !voice.isHandRaised()
    const btn = this.root.querySelector<HTMLButtonElement>('[data-community-voice-hand]')
    if (btn) {
      btn.disabled = true
      btn.textContent = next ? 'REQUESTING…' : 'LOWERING…'
    }
    const result = await voice.setHandRaised(next)
    if (btn) {
      btn.disabled = false
      if (!result.ok) {
        btn.title = result.error
        btn.textContent = 'Request failed'
      }
    }
  }

  private async toggleLocalMic(): Promise<void> {
    const voice = getCommunityVoiceSession()
    if (!voice.isActive()) return
    const state = voice.getState()
    await voice.setMicEnabled(!state.micEnabled)
  }

  private async modPromote(addr: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true
    const result = await getCommunityVoiceSession().promoteSpeaker(addr)
    if (!result.ok) {
      btn.disabled = false
      btn.title = result.error
    }
  }

  private async modReject(addr: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true
    const result = await getCommunityVoiceSession().rejectSpeakRequest(addr)
    if (!result.ok) {
      btn.disabled = false
      btn.title = result.error
    }
  }

  private async modDemote(addr: string, btn: HTMLButtonElement): Promise<void> {
    btn.disabled = true
    const result = await getCommunityVoiceSession().demoteSpeaker(addr)
    if (!result.ok) {
      btn.disabled = false
      btn.title = result.error
    }
  }

  private async endCommunityVoiceForEveryone(merged: CommunityDetail): Promise<void> {
    const identity = this.getAuthIdentity?.() ?? null
    if (!identity || !this.canStartVoice(merged)) return
    const endBtn = this.root.querySelector<HTMLButtonElement>('[data-community-voice-end]')
    if (endBtn) {
      endBtn.disabled = true
      endBtn.textContent = 'ENDING…'
    }
    const result = await endCommunityVoiceChatViaSocialRpc(identity, merged.id)
    const voice = getCommunityVoiceSession()
    if (voice.isActive() && voice.getCommunityId() === merged.id) {
      await voice.leave()
    }
    if (this.current?.id === merged.id) {
      this.current = { ...this.current, voiceChatActive: false }
      this.paint({ loading: false })
      this.wireVoiceSession()
    }
    if (!result.ok && endBtn) {
      endBtn.disabled = false
      endBtn.textContent = 'End failed'
      endBtn.title = result.error
    }
  }

  private async toggleCommunityVoice(merged: CommunityDetail): Promise<void> {
    const btn = this.root.querySelector<HTMLButtonElement>('[data-community-voice]')
    const voice = getCommunityVoiceSession()
    const identity = this.getAuthIdentity?.() ?? null
    const address = this.sessionAddress()
    const voiceLive = merged.voiceChatActive === true
    const canStart = this.canStartVoice(merged)

    if (voice.isActive() && voice.getCommunityId() === merged.id) {
      if (btn) {
        btn.disabled = true
        btn.textContent = 'LEAVING…'
      }
      // Last remaining owner/mod leaving → end voice for everyone (Explorer parity).
      // Server also tracks moderatorCount; we enforce on leave so the room doesn't orphan.
      if (this.canStartVoice(merged) && voice.isSoleRemainingMod()) {
        const identity = this.getAuthIdentity?.() ?? null
        if (identity) {
          const ended = await endCommunityVoiceChatViaSocialRpc(identity, merged.id)
          if (!ended.ok) {
            console.warn('[community-voice] end on last-mod leave failed', ended.error)
          }
        }
      }
      await voice.leave()
      if (this.current?.id === merged.id) {
        if (this.canStartVoice(merged)) {
          this.current = { ...this.current, voiceChatActive: false }
        }
        this.paint({ loading: false })
        this.wireVoiceSession()
      }
      return
    }

    if (!identity || !address) {
      if (btn) btn.textContent = 'Sign in required'
      return
    }

    // Create is mod-only; join as listener when a stream is already live.
    const action = voiceLive ? 'join' : 'create'
    if (action === 'create' && !canStart) {
      if (btn) {
        btn.textContent = 'Mods only'
        btn.title = 'Only owners, moderators, and admins can start a voice stream.'
      }
      return
    }

    if (btn) {
      btn.disabled = true
      btn.textContent = action === 'join' ? 'JOINING…' : 'STARTING…'
    }
    const result = await voice.join({
      identity,
      communityId: merged.id,
      userAddress: address,
      action,
      userRole: merged.role,
      displayName: undefined
    })
    if (this.current?.id === merged.id) {
      if (result.ok) {
        this.current = { ...this.current, voiceChatActive: true }
        this.paint({ loading: false })
        this.wireVoiceSession()
      } else if (btn) {
        btn.disabled = false
        btn.textContent =
          result.error.includes('401') ||
          result.error.includes('403') ||
          result.error.includes('Unauthorized') ||
          result.error.includes('Forbidden')
            ? 'Voice unavailable'
            : 'Voice failed'
        btn.title = result.error
      }
    }
  }

  private renderVoicePanel(merged: CommunityDetail): string {
    const voice = getCommunityVoiceSession()
    const state = this.voiceState ?? voice.getState()
    const inVoice = state.active && state.communityId === merged.id
    const signedIn = Boolean(this.getAuthIdentity?.())
    const canStart = this.canStartVoice(merged)
    const voiceLive = merged.voiceChatActive === true || inVoice
    const showVoiceCta = inVoice || voiceLive || canStart
    const voiceCtaEnabled = signedIn && (inVoice || voiceLive || canStart)

    const primary =
      showVoiceCta
        ? `<button
                  type="button"
                  class="community-modal-voice-cta${inVoice ? ' is-live' : ''}"
                  data-community-voice
                  ${voiceCtaEnabled ? '' : 'disabled'}
                  title="${
                    inVoice
                      ? 'Leave this voice stream'
                      : voiceLive
                        ? 'Join as listener (request to speak after)'
                        : 'Start a voice stream for members (owners and moderators)'
                  }"
                >${voiceBtnHtml(inVoice, voiceLive, canStart)}</button>`
        : `<p class="community-modal-voice-hint">No active stream. Owners and moderators can start one.</p>`

    const endBtn =
      canStart && (inVoice || voiceLive)
        ? `<button
                  type="button"
                  class="community-modal-voice-end"
                  data-community-voice-end
                  title="End voice for all participants (moderator)"
                >END FOR EVERYONE</button>`
        : ''

    let controls = ''
    if (inVoice) {
      const handLabel = state.handRaised ? '▼ LOWER HAND' : '✋ REQUEST TO SPEAK'
      const showHand = state.role === 'listener'
      const showMic = state.role === 'speaker' || state.canPublish
      const micLabel = state.micEnabled ? '🔇 MUTE MIC' : '🎤 UNMUTE MIC'
      controls = `<div class="community-modal-voice-controls">
        <p class="community-modal-voice-role">You are a <strong>${
          state.role === 'speaker' ? 'speaker' : 'listener'
        }</strong>${state.handRaised ? ' · hand raised' : ''}</p>
        ${
          showHand
            ? `<button type="button" class="community-modal-voice-secondary${
                state.handRaised ? ' is-raised' : ''
              }" data-community-voice-hand>${handLabel}</button>`
            : ''
        }
        ${
          showMic
            ? `<button type="button" class="community-modal-voice-secondary" data-community-voice-mic>${micLabel}</button>`
            : ''
        }
      </div>`
    }

    const roster = inVoice ? this.renderVoiceRoster(state.participants, canStart) : ''

    return `${primary}${controls}${endBtn}${roster}`
  }

  private renderVoiceRoster(participants: CommunityVoiceParticipant[], isMod: boolean): string {
    if (!participants.length) {
      return `<p class="community-modal-voice-hint">No participants yet.</p>`
    }
    const rows = participants
      .map((p) => {
        const wallet = p.wallet ?? walletFromIdentity(p.identity)
        const profile = wallet ? this.voiceProfiles.get(wallet) : null
        const displayName =
          profile?.displayName?.trim() ||
          p.name?.trim() ||
          (wallet ? shortenAddress(wallet) : shortIdentity(p.identity))
        const face = profile?.faceUrl
          ? `<img src="${escapeHtml(profile.faceUrl)}" alt="" class="community-modal-voice-avatar" />`
          : `<span class="community-modal-voice-avatar community-modal-voice-avatar--fallback">${escapeHtml(
              displayName.charAt(0).toUpperCase() || '?'
            )}</span>`
        const badges: string[] = []
        if (p.isLocal) badges.push('you')
        if (p.isMod) badges.push('mod')
        if (p.isSpeaker) badges.push('speaker')
        else badges.push('listener')
        if (p.handRaised) badges.push('✋')
        if (p.isSpeaking) badges.push('🎙')
        const badgeHtml = badges
          .map((b) => `<span class="community-modal-voice-badge">${escapeHtml(b)}</span>`)
          .join('')
        const copyBtn = wallet
          ? `<button
              type="button"
              class="community-modal-voice-copy"
              data-voice-copy-wallet="${escapeHtml(wallet)}"
              title="Copy wallet"
              aria-label="Copy wallet address"
            >⧉</button>`
          : ''
        let actions = ''
        if (isMod && !p.isLocal) {
          const target = wallet || p.identity
          if (p.handRaised && !p.isSpeaker) {
            actions = `<span class="community-modal-voice-actions">
              <button type="button" class="community-modal-voice-mini" data-voice-promote="${escapeHtml(
                target
              )}" title="Accept speak request">Accept</button>
              <button type="button" class="community-modal-voice-mini community-modal-voice-mini--danger" data-voice-reject="${escapeHtml(
                target
              )}" title="Reject speak request">Reject</button>
            </span>`
          } else if (p.isSpeaker) {
            actions = `<span class="community-modal-voice-actions">
              <button type="button" class="community-modal-voice-mini" data-voice-demote="${escapeHtml(
                target
              )}" title="Demote to listener">Demote</button>
            </span>`
          }
        }
        return `<div class="community-modal-voice-row">
          <div class="community-modal-voice-row-main">
            ${face}
            <div class="community-modal-voice-identity">
              <span class="community-modal-voice-name">${escapeHtml(displayName)}</span>
              <span class="community-modal-voice-badges">${badgeHtml}</span>
            </div>
            ${copyBtn}
          </div>
          ${actions}
        </div>`
      })
      .join('')
    return `<div class="community-modal-voice-roster">
      <h4 class="community-modal-voice-roster-title">Voice Chat (${participants.length})</h4>
      ${rows}
    </div>`
  }

  private renderAnnouncements(): string {
    // Companion: create-post control is omitted unless owner/moderator (or owner wallet).
    const composer = this.canPostAnnouncements()
      ? `
      <form class="community-modal-composer" data-post-form>
        <textarea
          class="community-modal-composer-input"
          data-post-input
          rows="3"
          maxlength="1000"
          placeholder="Any Announcement to share with your Community?"
        ></textarea>
        <div class="community-modal-composer-bar">
          <span class="community-modal-post-status" data-post-status></span>
          <button type="submit" class="community-modal-post-btn">POST</button>
        </div>
      </form>`
      : ''

    if (this.posts.length === 0) {
      return `${composer}<p class="community-modal-tab-status">No announcements yet.</p>`
    }

    const feed = this.posts
      .map((p) => {
        const face = p.authorProfilePictureUrl
          ? `<img src="${escapeHtml(p.authorProfilePictureUrl)}" alt="" class="community-modal-post-avatar" />`
          : `<span class="community-modal-post-avatar community-modal-post-avatar--fallback">${escapeHtml(
              (p.authorName || '?').charAt(0).toUpperCase()
            )}</span>`
        const liked = p.isLikedByUser ? ' is-liked' : ''
        return `
        <article class="community-modal-post" data-post-id="${escapeHtml(p.id)}">
          <div class="community-modal-post-top">
            ${face}
            <div class="community-modal-post-meta">
              <span class="community-modal-post-author">${escapeHtml(p.authorName)}${
                p.authorHasClaimedName
                  ? '<span class="community-modal-claimed" title="Claimed name" aria-label="Claimed name">✓</span>'
                  : ''
              }</span>
              <span class="community-modal-post-date">${escapeHtml(formatPostDate(p.createdAt))}</span>
            </div>
            <button type="button" class="community-modal-like${liked}" data-like="${escapeHtml(p.id)}" title="Like">
              ♥ <span>${p.likesCount}</span>
            </button>
          </div>
          <div class="community-modal-post-body">${linkify(p.content)}</div>
        </article>`
      })
      .join('')

    return `${composer}<div class="community-modal-feed">${feed}</div>`
  }

  private renderMembers(): string {
    if (this.members.length === 0) {
      return `<p class="community-modal-tab-status">No members loaded.</p>`
    }
    const rows = this.members
      .map((m) => {
        const face = m.profilePictureUrl
          ? `<img src="${escapeHtml(m.profilePictureUrl)}" alt="" class="community-modal-member-avatar" />`
          : `<span class="community-modal-member-avatar community-modal-member-avatar--fallback">${escapeHtml(
              (m.name || '?').charAt(0).toUpperCase()
            )}</span>`
        const role = (m.role || 'member').toLowerCase()
        const roleLabel =
          role === 'owner' ? 'Owner' : role === 'moderator' ? 'Moderator' : 'Member'
        return `
        <div class="community-modal-member-row">
          ${face}
          <div class="community-modal-member-info">
            <span class="community-modal-member-name">${escapeHtml(m.name || m.address.slice(0, 10))}</span>
            <span class="community-modal-member-role">${escapeHtml(roleLabel)}</span>
          </div>
        </div>`
      })
      .join('')
    return `<div class="community-modal-members">${rows}</div>`
  }

  private renderPlaces(): string {
    if (this.placeIds.length === 0) {
      return `<p class="community-modal-tab-status">No places linked to this community.</p>`
    }
    const rows = this.placeIds
      .map(
        (pid) => `
      <a class="community-modal-place-row" href="/${encodeURIComponent(pid)}" target="_blank" rel="noopener">
        <span class="community-modal-place-id">${escapeHtml(pid)}</span>
        <span class="community-modal-place-go">Open →</span>
      </a>`
      )
      .join('')
    return `<div class="community-modal-places">${rows}</div>`
  }

  private renderPhotos(): string {
    return `
      <div class="community-modal-photos-empty">
        <div class="community-modal-photos-icon" aria-hidden>🖼</div>
        <p>No community photos yet.</p>
        <p class="community-modal-tab-hint">Gallery / photo posts will show here when available.</p>
      </div>`
  }

  private renderShell(
    merged: CommunityDetail,
    opts: { loading?: boolean; detailError?: string | null }
  ): string {
    const thumb = communityDisplayImageUrl(merged.id, merged.thumbnails)
    const visibility = merged.isPrivate === true ? 'Private' : 'Public'
    const members = formatMemberCount(merged.memberCount)
    const desc = (merged.description || '').trim()
    const statusHint = opts.loading
      ? `<p class="community-modal-status-hint">Loading details…</p>`
      : opts.detailError
        ? `<p class="community-modal-status-hint community-modal-status-hint--error">${escapeHtml(opts.detailError)}</p>`
        : ''

    return `
      <div class="community-modal-backdrop" role="presentation">
        <div class="community-modal-panel" role="dialog" aria-modal="true" aria-labelledby="community-modal-title">
          <div class="community-modal-layout">
            <div class="community-modal-primary">
              <header class="community-modal-header">
                <div class="community-modal-header-left">
                  <div class="community-modal-logo">
                    ${
                      thumb
                        ? `<img src="${escapeHtml(thumb)}" alt="" class="community-modal-logo-img" />`
                        : `<span class="community-modal-logo-fallback">${escapeHtml(
                            merged.name.charAt(0).toUpperCase() || '?'
                          )}</span>`
                    }
                  </div>
                  <div class="community-modal-header-text">
                    <h2 id="community-modal-title" class="community-modal-title">${escapeHtml(merged.name)}</h2>
                    <p class="community-modal-meta-line">
                      <span>${escapeHtml(visibility)}</span>
                      <span class="community-modal-meta-dot" aria-hidden>·</span>
                      <span>${escapeHtml(members)}</span>
                    </p>
                  </div>
                </div>
                <div class="community-modal-header-actions">
                  <button type="button" class="community-modal-icon-btn" data-community-chat title="Community chat" aria-label="Community chat">💬</button>
                  <button type="button" class="community-modal-icon-btn" data-community-copy title="Copy link" aria-label="Copy link">🔗</button>
                  <button type="button" class="community-modal-close" aria-label="Close">&times;</button>
                </div>
              </header>
              ${statusHint}
              ${
                desc
                  ? `<div class="community-modal-desc">${desc
                      .split(/\n+/)
                      .filter(Boolean)
                      .map((p) => `<p>${linkify(p)}</p>`)
                      .join('')}</div>`
                  : ''
              }
              <nav class="community-modal-tabs" role="tablist">
                <button type="button" class="community-modal-tab${
                  this.tab === 'announcements' ? ' is-active' : ''
                }" data-tab="announcements" role="tab">ANNOUNCEMENTS</button>
                <button type="button" class="community-modal-tab${
                  this.tab === 'members' ? ' is-active' : ''
                }" data-tab="members" role="tab">MEMBERS</button>
                <button type="button" class="community-modal-tab${
                  this.tab === 'places' ? ' is-active' : ''
                }" data-tab="places" role="tab">PLACES</button>
                <button type="button" class="community-modal-tab${
                  this.tab === 'photos' ? ' is-active' : ''
                }" data-tab="photos" role="tab">PHOTOS</button>
              </nav>
              <div class="community-modal-tab-body" data-tab-body></div>
            </div>
            <aside class="community-modal-rail">
              <section class="community-modal-rail-card">
                <h3 class="community-modal-rail-title">Voice Stream</h3>
                <div data-community-voice-panel>${this.renderVoicePanel(merged)}</div>
                <div class="community-modal-tour-slot" data-community-tour-slot>
                  ${this.renderTourCta(merged)}
                </div>
              </section>
              <section class="community-modal-rail-card community-modal-rail-card--events">
                <div class="community-modal-rail-title-row">
                  <h3 class="community-modal-rail-title">Upcoming Events</h3>
                </div>
                <div class="community-modal-events-empty">
                  <div class="community-modal-events-icon" aria-hidden>📅</div>
                  <p class="community-modal-events-empty-title">No Upcoming Events</p>
                  <p class="community-modal-events-empty-hint">Link an event to your community from the Events page.</p>
                </div>
              </section>
            </aside>
          </div>
        </div>
      </div>
    `
  }
}

function voiceBtnHtml(inVoice: boolean, active: boolean, canStart: boolean): string {
  if (inVoice) return '● LEAVE VOICE'
  if (active) return '◉ JOIN AS LISTENER'
  if (canStart) return '◉ START VOICE STREAM'
  return '◉ VOICE STREAM'
}

function shortIdentity(id: string): string {
  const t = id.trim()
  if (t.length <= 14) return t
  return `${t.slice(0, 8)}…${t.slice(-4)}`
}
