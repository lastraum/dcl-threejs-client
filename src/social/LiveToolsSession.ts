/**
 * In-scene live polls + Q&A control plane.
 * Transport: scene LiveKit topic `d3js-live-tools:{placeKey}` (not chat).
 */

import {
  encodeLiveToolsDataPacket,
  isLiveToolsHost,
  liveToolsTopic,
  LIVE_TOOLS_POLL_OPTIONS_MAX,
  LIVE_TOOLS_POLL_OPTIONS_MIN,
  LIVE_TOOLS_QA_TEXT_MAX,
  LIVE_TOOLS_QUESTION_MAX,
  newLiveToolsId,
  parseLiveToolsTopic,
  tryParseLiveToolsDataPacket,
  type LivePollState,
  type LiveProjectedQuestion,
  type LiveQaItem,
  type LiveToolsWireMsg
} from './liveToolsWire'

export type LiveToolsSessionOptions = {
  placeKey: string
  ownerAddresses: string[]
  getLocalWallet: () => string | null
  getDisplayName: () => string | null
  publish: (topic: string, packet: Uint8Array) => Promise<boolean>
  onChange?: () => void
}

export type LiveToolsSnapshot = {
  placeKey: string
  isHost: boolean
  poll: LivePollState | null
  /** Local wallet already voted on current poll. */
  localVotedOption: number | null
  projected: LiveProjectedQuestion
  qaInbox: LiveQaItem[]
}

export class LiveToolsSession {
  private readonly placeKey: string
  private readonly topic: string
  private ownerAddresses: string[]
  private readonly getLocalWallet: () => string | null
  private readonly getDisplayName: () => string | null
  private readonly publish: (topic: string, packet: Uint8Array) => Promise<boolean>
  private readonly onChange?: () => void

  private poll: LivePollState | null = null
  private projected: LiveProjectedQuestion = null
  private qaInbox: LiveQaItem[] = []
  /** pollId → option index for local vote. */
  private localVotes = new Map<string, number>()
  private disposed = false
  private helloTimer: number | null = null

  constructor(opts: LiveToolsSessionOptions) {
    this.placeKey = opts.placeKey.trim().toLowerCase()
    this.topic = liveToolsTopic(this.placeKey)
    this.ownerAddresses = opts.ownerAddresses.map((a) => a.trim().toLowerCase()).filter(Boolean)
    this.getLocalWallet = opts.getLocalWallet
    this.getDisplayName = opts.getDisplayName
    this.publish = opts.publish
    this.onChange = opts.onChange
  }

  getTopic(): string {
    return this.topic
  }

  getPlaceKey(): string {
    return this.placeKey
  }

  setOwnerAddresses(owners: string[]): void {
    this.ownerAddresses = owners.map((a) => a.trim().toLowerCase()).filter(Boolean)
    this.emit()
  }

  isHost(): boolean {
    return isLiveToolsHost(this.getLocalWallet(), this.ownerAddresses)
  }

  snapshot(): LiveToolsSnapshot {
    const poll = this.poll
    const local = this.getLocalWallet()?.toLowerCase() ?? null
    let localVotedOption: number | null = null
    if (poll) {
      localVotedOption = this.localVotes.get(poll.id) ?? null
      if (localVotedOption == null && local && poll.voters?.includes(local)) {
        localVotedOption = -1
      }
    }
    return {
      placeKey: this.placeKey,
      isHost: this.isHost(),
      poll,
      localVotedOption,
      projected: this.projected,
      qaInbox: this.qaInbox.filter((q) => !q.dismissed)
    }
  }

  /** Call after scene comms is up — ask host for resync. */
  start(): void {
    if (this.disposed) return
    void this.send({ t: 'session_hello', at: Date.now() })
    // Retry once — host may still be connecting.
    this.helloTimer = window.setTimeout(() => {
      if (this.disposed) return
      if (!this.poll && !this.projected) {
        void this.send({ t: 'session_hello', at: Date.now() })
      }
    }, 2500)
  }

  handleInbound(topic: string, sender: string, payload: Uint8Array): void {
    if (this.disposed) return
    const key = parseLiveToolsTopic(topic)
    if (!key || key !== this.placeKey) return
    const msg = tryParseLiveToolsDataPacket(payload)
    if (!msg) return
    const from = sender.trim().toLowerCase()
    this.applyInbound(msg, from)
  }

  // ── Host actions ──────────────────────────────────────────────────────────

  async openPoll(question: string, options: string[]): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    const q = question.trim().slice(0, LIVE_TOOLS_QUESTION_MAX)
    const opts = options
      .map((s) => s.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, LIVE_TOOLS_POLL_OPTIONS_MAX)
    if (!q) return { ok: false, error: 'Enter a question' }
    if (opts.length < LIVE_TOOLS_POLL_OPTIONS_MIN) {
      return { ok: false, error: `Need at least ${LIVE_TOOLS_POLL_OPTIONS_MIN} options` }
    }
    const id = newLiveToolsId()
    const at = Date.now()
    this.poll = {
      id,
      question: q,
      options: opts,
      counts: opts.map(() => 0),
      voters: [],
      open: true,
      at
    }
    this.localVotes.delete(id)
    this.emit()
    const sent = await this.send({ t: 'poll_open', id, q, opts, at })
    if (!sent) return { ok: false, error: 'Comms not connected — try again in a moment' }
    return { ok: true }
  }

  async closePoll(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    const poll = this.poll
    if (!poll) return { ok: false, error: 'No active poll' }
    poll.open = false
    const at = Date.now()
    this.emit()
    const sent = await this.send({
      t: 'poll_close',
      id: poll.id,
      counts: [...poll.counts],
      at
    })
    if (!sent) return { ok: false, error: 'Comms not connected' }
    return { ok: true }
  }

  async clearPoll(): Promise<void> {
    if (!this.isHost()) return
    this.poll = null
    this.emit()
    await this.send({ t: 'poll_sync', poll: null, at: Date.now() })
  }

  async projectQuestion(item: LiveQaItem | null): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    const at = Date.now()
    if (!item) {
      this.projected = null
      this.emit()
      const sent = await this.send({ t: 'qa_project', id: null, at })
      return sent ? { ok: true } : { ok: false, error: 'Comms not connected' }
    }
    this.projected = {
      id: item.id,
      text: item.text,
      from: item.from,
      name: item.name
    }
    this.emit()
    const sent = await this.send({
      t: 'qa_project',
      id: item.id,
      text: item.text,
      a: item.from,
      n: item.name,
      at
    })
    return sent ? { ok: true } : { ok: false, error: 'Comms not connected' }
  }

  async dismissQuestion(id: string): Promise<void> {
    if (!this.isHost()) return
    const q = this.qaInbox.find((x) => x.id === id)
    if (q) q.dismissed = true
    if (this.projected?.id === id) this.projected = null
    this.emit()
    await this.send({ t: 'qa_dismiss', id, at: Date.now() })
    if (this.projected === null) {
      await this.send({ t: 'qa_project', id: null, at: Date.now() })
    }
  }

  // ── Participant actions ───────────────────────────────────────────────────

  async vote(optionIndex: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const poll = this.poll
    if (!poll || !poll.open) return { ok: false, error: 'No open poll' }
    const wallet = this.getLocalWallet()?.toLowerCase() ?? null
    if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return { ok: false, error: 'Sign in with a wallet to vote' }
    }
    if (this.localVotes.has(poll.id)) return { ok: false, error: 'Already voted' }
    if (optionIndex < 0 || optionIndex >= poll.options.length) {
      return { ok: false, error: 'Invalid option' }
    }
    // Host can also vote — counts locally + broadcast
    if (this.isHost()) {
      this.applyVoteAsHost(poll, wallet, optionIndex)
      this.localVotes.set(poll.id, optionIndex)
      this.emit()
      // Rebroadcast sync so peers see tallies (host is authoritative)
      await this.send({ t: 'poll_sync', poll: this.clonePollForWire(poll), at: Date.now() })
      return { ok: true }
    }
    this.localVotes.set(poll.id, optionIndex)
    this.emit()
    const sent = await this.send({
      t: 'poll_vote',
      id: poll.id,
      i: optionIndex,
      a: wallet
    })
    if (!sent) {
      this.localVotes.delete(poll.id)
      this.emit()
      return { ok: false, error: 'Comms not connected' }
    }
    return { ok: true }
  }

  async askQuestion(text: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const body = text.trim().slice(0, LIVE_TOOLS_QA_TEXT_MAX)
    if (!body) return { ok: false, error: 'Enter a question' }
    const wallet = this.getLocalWallet()?.toLowerCase() ?? null
    if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return { ok: false, error: 'Sign in with a wallet to ask' }
    }
    const id = newLiveToolsId()
    const at = Date.now()
    const name = this.getDisplayName()?.trim() || undefined
    // Host sees own question immediately
    if (this.isHost()) {
      this.upsertQa({ id, text: body, from: wallet, name, at })
      this.emit()
    }
    const sent = await this.send({
      t: 'qa_ask',
      id,
      text: body,
      a: wallet,
      n: name,
      at
    })
    if (!sent) return { ok: false, error: 'Comms not connected' }
    return { ok: true }
  }

  dispose(): void {
    this.disposed = true
    if (this.helloTimer != null) {
      window.clearTimeout(this.helloTimer)
      this.helloTimer = null
    }
    this.poll = null
    this.projected = null
    this.qaInbox = []
    this.localVotes.clear()
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private applyInbound(msg: LiveToolsWireMsg, from: string): void {
    const fromHost = this.ownerAddresses.includes(from)

    switch (msg.t) {
      case 'session_hello': {
        if (this.isHost() && from !== this.getLocalWallet()?.toLowerCase()) {
          void this.sendSessionSync()
        }
        return
      }
      case 'session_sync': {
        if (!fromHost) return
        this.poll = msg.poll
        this.projected = msg.projected
        if (this.isHost() && msg.qa) {
          for (const q of msg.qa) this.upsertQa(q)
        }
        this.emit()
        return
      }
      case 'poll_open': {
        if (!fromHost) return
        this.poll = {
          id: msg.id,
          question: msg.q,
          options: msg.opts,
          counts: msg.opts.map(() => 0),
          voters: [],
          open: true,
          at: msg.at
        }
        this.emit()
        return
      }
      case 'poll_vote': {
        if (!this.isHost()) return
        const poll = this.poll
        if (!poll || !poll.open || poll.id !== msg.id) return
        this.applyVoteAsHost(poll, msg.a, msg.i)
        this.emit()
        // Fan out updated tallies (without full voter list to keep packets small)
        void this.send({ t: 'poll_sync', poll: this.clonePollForWire(poll), at: Date.now() })
        return
      }
      case 'poll_close': {
        if (!fromHost) return
        if (this.poll?.id === msg.id) {
          this.poll.open = false
          if (msg.counts.length === this.poll.options.length) {
            this.poll.counts = [...msg.counts]
          }
        }
        this.emit()
        return
      }
      case 'poll_sync': {
        if (!fromHost) return
        this.poll = msg.poll
        this.emit()
        return
      }
      case 'qa_ask': {
        // Host collects; if we are host, inbox. Peers only care when projected.
        if (this.isHost()) {
          this.upsertQa({
            id: msg.id,
            text: msg.text,
            from: msg.a,
            name: msg.n,
            at: msg.at
          })
          this.emit()
        }
        return
      }
      case 'qa_project': {
        if (!fromHost) return
        if (msg.id == null) {
          this.projected = null
        } else {
          this.projected = {
            id: msg.id,
            text: msg.text ?? '',
            from: msg.a,
            name: msg.n
          }
        }
        this.emit()
        return
      }
      case 'qa_dismiss': {
        if (!fromHost) return
        const q = this.qaInbox.find((x) => x.id === msg.id)
        if (q) q.dismissed = true
        if (this.projected?.id === msg.id) this.projected = null
        this.emit()
        return
      }
    }
  }

  private applyVoteAsHost(poll: LivePollState, voter: string, optionIndex: number): void {
    const a = voter.trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(a)) return
    if (optionIndex < 0 || optionIndex >= poll.options.length) return
    if (!poll.voters) poll.voters = []
    if (poll.voters.includes(a)) return
    poll.voters.push(a)
    poll.counts[optionIndex] = (poll.counts[optionIndex] ?? 0) + 1
  }

  private clonePollForWire(poll: LivePollState): LivePollState {
    return {
      id: poll.id,
      question: poll.question,
      options: [...poll.options],
      counts: [...poll.counts],
      // Omit full voter list on wire to peers — only counts matter for display
      open: poll.open,
      at: poll.at
    }
  }

  private upsertQa(item: LiveQaItem): void {
    if (this.qaInbox.some((q) => q.id === item.id)) return
    this.qaInbox.unshift(item)
    if (this.qaInbox.length > 80) this.qaInbox.length = 80
  }

  private async sendSessionSync(): Promise<void> {
    if (!this.isHost()) return
    await this.send({
      t: 'session_sync',
      poll: this.poll ? this.clonePollForWire(this.poll) : null,
      projected: this.projected,
      qa: this.isHost() ? this.qaInbox.filter((q) => !q.dismissed).slice(0, 40) : undefined,
      at: Date.now()
    })
  }

  private async send(msg: LiveToolsWireMsg): Promise<boolean> {
    if (this.disposed) return false
    try {
      return await this.publish(this.topic, encodeLiveToolsDataPacket(msg))
    } catch {
      return false
    }
  }

  private emit(): void {
    this.onChange?.()
  }
}
