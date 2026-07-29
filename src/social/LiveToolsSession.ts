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
  LIVE_TOOLS_TRIVIA_OPTIONS_MAX,
  LIVE_TOOLS_TRIVIA_OPTIONS_MIN,
  newLiveToolsId,
  parseLiveToolsTopic,
  tryParseLiveToolsDataPacket,
  type LivePollState,
  type LiveProjectedQuestion,
  type LiveQaItem,
  type LiveToolsWireMsg,
  type LiveTriviaQuestion
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
  /** Host has started a Live Q&A session. */
  qaActive: boolean
  qaInbox: LiveQaItem[]
  /** Host has started a Trivia session. */
  triviaActive: boolean
  triviaStartedAt: number | null
  triviaCurrent: LiveTriviaQuestion | null
  triviaHistory: LiveTriviaQuestion[]
  /** Local vote on current trivia question. */
  triviaLocalVotedOption: number | null
  triviaQuestionCount: number
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
  private qaActive = false
  private qaInbox: LiveQaItem[] = []
  private triviaActive = false
  private triviaStartedAt: number | null = null
  private triviaCurrent: LiveTriviaQuestion | null = null
  private triviaHistory: LiveTriviaQuestion[] = []
  private triviaQuestionSeq = 0
  /** pollId / triviaId → option index for local vote. */
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
    const tq = this.triviaCurrent
    let triviaLocalVotedOption: number | null = null
    if (tq) {
      triviaLocalVotedOption = this.localVotes.get(tq.id) ?? null
      if (triviaLocalVotedOption == null && local && tq.voters?.includes(local)) {
        triviaLocalVotedOption = -1
      }
    }
    return {
      placeKey: this.placeKey,
      isHost: this.isHost(),
      poll,
      localVotedOption,
      projected: this.projected,
      qaActive: this.qaActive,
      qaInbox: this.qaInbox.filter((q) => !q.dismissed),
      triviaActive: this.triviaActive,
      triviaStartedAt: this.triviaStartedAt,
      triviaCurrent: tq,
      triviaHistory: [...this.triviaHistory],
      triviaLocalVotedOption,
      triviaQuestionCount: this.triviaQuestionSeq
    }
  }

  /** Call after scene comms is up — ask host for resync. */
  start(): void {
    if (this.disposed) return
    void this.send({ t: 'session_hello', at: Date.now() })
    // Retry once — host may still be connecting.
    this.helloTimer = window.setTimeout(() => {
      if (this.disposed) return
      if (!this.poll && !this.projected && !this.qaActive && !this.triviaActive) {
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

  async startQaSession(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    this.qaActive = true
    this.emit()
    const sent = await this.send({ t: 'qa_session', on: true, at: Date.now() })
    if (!sent) return { ok: false, error: 'Comms not connected — try again in a moment' }
    return { ok: true }
  }

  async stopQaSession(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    this.qaActive = false
    this.projected = null
    this.emit()
    const sent = await this.send({ t: 'qa_session', on: false, at: Date.now() })
    if (!sent) return { ok: false, error: 'Comms not connected' }
    return { ok: true }
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

  async answerQuestion(
    id: string,
    answerText: string
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    if (!this.qaActive) return { ok: false, error: 'Start Q&A first' }
    const body = answerText.trim().slice(0, LIVE_TOOLS_QA_TEXT_MAX)
    if (!body) return { ok: false, error: 'Enter an answer' }
    const q = this.qaInbox.find((x) => x.id === id && !x.dismissed)
    if (!q) return { ok: false, error: 'Question not found' }
    const at = Date.now()
    const wallet = this.getLocalWallet()?.toLowerCase() || undefined
    const name = this.getDisplayName()?.trim() || undefined
    q.answer = body
    q.answeredAt = at
    q.answeredBy = wallet
    q.answeredName = name
    this.emit()
    const sent = await this.send({
      t: 'qa_answer',
      id,
      text: body,
      a: wallet,
      n: name,
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
      return { ok: false, error: 'Sign in (wallet or guest) to vote' }
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
    if (!this.qaActive) return { ok: false, error: 'Q&A is not live yet' }
    const body = text.trim().slice(0, LIVE_TOOLS_QA_TEXT_MAX)
    if (!body) return { ok: false, error: 'Enter a question' }
    const wallet = this.getLocalWallet()?.toLowerCase() ?? null
    if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return { ok: false, error: 'Sign in (wallet or guest) to ask' }
    }
    const id = newLiveToolsId()
    const at = Date.now()
    const name = this.getDisplayName()?.trim() || undefined
    // Everyone sees their own question immediately; peers get qa_ask broadcast.
    this.upsertQa({ id, text: body, from: wallet, name, at })
    this.emit()
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

  // ── Trivia ────────────────────────────────────────────────────────────────

  async startTrivia(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    this.triviaActive = true
    this.triviaStartedAt = Date.now()
    this.triviaCurrent = null
    this.triviaHistory = []
    this.triviaQuestionSeq = 0
    this.emit()
    const sent = await this.send({ t: 'trivia_session', on: true, at: this.triviaStartedAt })
    if (!sent) return { ok: false, error: 'Comms not connected — try again in a moment' }
    return { ok: true }
  }

  async endTrivia(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    // Archive open question into history for stats.
    if (this.triviaCurrent) {
      this.archiveTriviaCurrent()
    }
    this.triviaActive = false
    this.triviaCurrent = null
    this.emit()
    const sent = await this.send({ t: 'trivia_session', on: false, at: Date.now() })
    if (!sent) return { ok: false, error: 'Comms not connected' }
    return { ok: true }
  }

  /** Pose a multi-choice trivia question to the room. */
  async askTriviaQuestion(
    question: string,
    options: string[],
    correctIndex: number
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    if (!this.triviaActive) return { ok: false, error: 'Start Trivia first' }
    const q = question.trim().slice(0, LIVE_TOOLS_QUESTION_MAX)
    const opts = options
      .map((s) => s.trim().slice(0, 80))
      .filter(Boolean)
      .slice(0, LIVE_TOOLS_TRIVIA_OPTIONS_MAX)
    if (!q) return { ok: false, error: 'Enter a question' }
    if (opts.length < LIVE_TOOLS_TRIVIA_OPTIONS_MIN) {
      return { ok: false, error: `Need at least ${LIVE_TOOLS_TRIVIA_OPTIONS_MIN} options` }
    }
    if (
      !Number.isFinite(correctIndex) ||
      correctIndex < 0 ||
      correctIndex >= opts.length
    ) {
      return { ok: false, error: 'Mark the correct answer' }
    }
    if (this.triviaCurrent?.open) {
      this.archiveTriviaCurrent()
    }
    const id = newLiveToolsId()
    const at = Date.now()
    this.triviaQuestionSeq += 1
    const ci = Math.floor(correctIndex)
    this.triviaCurrent = {
      id,
      index: this.triviaQuestionSeq,
      question: q,
      options: opts,
      counts: opts.map(() => 0),
      voters: [],
      correctIndex: ci,
      open: true,
      revealed: false,
      at
    }
    this.emit()
    // Do not send correct index on ask — only on reveal (avoids spoilers for peers).
    const sent = await this.send({
      t: 'trivia_ask',
      id,
      index: this.triviaQuestionSeq,
      q,
      opts,
      at
    })
    if (!sent) return { ok: false, error: 'Comms not connected' }
    return { ok: true }
  }

  async voteTrivia(optionIndex: number): Promise<{ ok: true } | { ok: false; error: string }> {
    const tq = this.triviaCurrent
    if (!this.triviaActive || !tq || !tq.open) return { ok: false, error: 'No open trivia question' }
    const wallet = this.getLocalWallet()?.toLowerCase() ?? null
    if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet)) {
      return { ok: false, error: 'Sign in (wallet or guest) to answer' }
    }
    if (this.localVotes.has(tq.id)) return { ok: false, error: 'Already answered' }
    if (optionIndex < 0 || optionIndex >= tq.options.length) {
      return { ok: false, error: 'Invalid option' }
    }
    if (this.isHost()) {
      this.applyTriviaVoteAsHost(tq, wallet, optionIndex)
      this.localVotes.set(tq.id, optionIndex)
      this.emit()
      await this.send({ t: 'trivia_sync', current: this.cloneTriviaForWire(tq), at: Date.now() })
      return { ok: true }
    }
    this.localVotes.set(tq.id, optionIndex)
    this.emit()
    const sent = await this.send({
      t: 'trivia_vote',
      id: tq.id,
      i: optionIndex,
      a: wallet
    })
    if (!sent) {
      this.localVotes.delete(tq.id)
      this.emit()
      return { ok: false, error: 'Comms not connected' }
    }
    return { ok: true }
  }

  /** Host: lock voting and show tallies + correct answer to everyone. */
  async revealTriviaResults(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    const tq = this.triviaCurrent
    if (!tq) return { ok: false, error: 'No active question' }
    tq.open = false
    tq.revealed = true
    tq.closedAt = Date.now()
    this.emit()
    const sent = await this.send({
      t: 'trivia_reveal',
      id: tq.id,
      counts: [...tq.counts],
      ci: tq.correctIndex != null ? tq.correctIndex : undefined,
      at: tq.closedAt
    })
    if (!sent) return { ok: false, error: 'Comms not connected' }
    return { ok: true }
  }

  /** Host: clear current question so they can compose the next. Archives if still open. */
  async nextTriviaQuestion(): Promise<{ ok: true } | { ok: false; error: string }> {
    if (!this.isHost()) return { ok: false, error: 'Scene owner only' }
    if (!this.triviaActive) return { ok: false, error: 'Trivia not active' }
    if (this.triviaCurrent) this.archiveTriviaCurrent()
    this.triviaCurrent = null
    this.emit()
    const sent = await this.send({ t: 'trivia_sync', current: null, at: Date.now() })
    if (!sent) return { ok: false, error: 'Comms not connected' }
    return { ok: true }
  }

  /** CSV of all trivia questions + tallies (host history + current). */
  buildTriviaStatsCsv(): string {
    const rows: LiveTriviaQuestion[] = [
      ...this.triviaHistory,
      ...(this.triviaCurrent ? [this.triviaCurrent] : [])
    ]
    const header = [
      'question_index',
      'question_id',
      'question',
      'option_index',
      'option',
      'votes',
      'is_correct',
      'open',
      'revealed',
      'asked_at_iso'
    ].join(',')
    const lines = [header]
    for (const q of rows) {
      const total = q.counts.reduce((a, b) => a + b, 0)
      for (let i = 0; i < q.options.length; i++) {
        lines.push(
          [
            String(q.index),
            csvEsc(q.id),
            csvEsc(q.question),
            String(i + 1),
            csvEsc(q.options[i] ?? ''),
            String(q.counts[i] ?? 0),
            q.correctIndex === i ? 'yes' : 'no',
            q.open ? 'yes' : 'no',
            q.revealed ? 'yes' : 'no',
            csvEsc(new Date(q.at).toISOString())
          ].join(',')
        )
      }
      lines.push(
        [
          String(q.index),
          csvEsc(q.id),
          csvEsc(q.question),
          'TOTAL',
          '',
          String(total),
          '',
          '',
          '',
          ''
        ].join(',')
      )
    }
    return lines.join('\n')
  }

  dispose(): void {
    this.disposed = true
    if (this.helloTimer != null) {
      window.clearTimeout(this.helloTimer)
      this.helloTimer = null
    }
    this.poll = null
    this.projected = null
    this.qaActive = false
    this.qaInbox = []
    this.triviaActive = false
    this.triviaStartedAt = null
    this.triviaCurrent = null
    this.triviaHistory = []
    this.triviaQuestionSeq = 0
    this.localVotes.clear()
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private applyInbound(msg: LiveToolsWireMsg, from: string): void {
    const fromHost = this.ownerAddresses.includes(from)
    const me = this.getLocalWallet()?.toLowerCase() ?? ''

    switch (msg.t) {
      case 'session_hello': {
        if (this.isHost() && from !== me) {
          void this.sendSessionSync()
        }
        return
      }
      case 'session_sync': {
        if (!fromHost) return
        this.poll = msg.poll
        this.projected = msg.projected
        if (typeof msg.qaOn === 'boolean') this.qaActive = msg.qaOn
        if (msg.qa) {
          this.qaInbox = []
          for (const q of msg.qa) this.upsertQa(q)
        }
        if (typeof msg.triviaOn === 'boolean') {
          this.triviaActive = msg.triviaOn
          if (msg.triviaOn && !this.triviaStartedAt) this.triviaStartedAt = Date.now()
          if (!msg.triviaOn) {
            this.triviaCurrent = null
          }
        }
        if (msg.triviaCurrent !== undefined) {
          this.triviaCurrent = msg.triviaCurrent
          if (msg.triviaCurrent) {
            this.triviaQuestionSeq = Math.max(this.triviaQuestionSeq, msg.triviaCurrent.index)
          }
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
      case 'qa_session': {
        if (!fromHost) return
        this.qaActive = msg.on
        if (!msg.on) this.projected = null
        this.emit()
        return
      }
      case 'qa_ask': {
        // Shared list while Q&A is live (skip own echo already upserted).
        if (msg.a === me) return
        this.upsertQa({
          id: msg.id,
          text: msg.text,
          from: msg.a,
          name: msg.n,
          at: msg.at
        })
        this.emit()
        return
      }
      case 'qa_answer': {
        if (!fromHost) return
        const q = this.qaInbox.find((x) => x.id === msg.id)
        if (q) {
          q.answer = msg.text
          q.answeredAt = msg.at
          q.answeredBy = msg.a
          q.answeredName = msg.n
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
      case 'trivia_session': {
        if (!fromHost) return
        this.triviaActive = msg.on
        if (msg.on) {
          if (!this.triviaStartedAt) this.triviaStartedAt = msg.at
        } else {
          this.triviaCurrent = null
        }
        this.emit()
        return
      }
      case 'trivia_ask': {
        if (!fromHost) return
        this.triviaActive = true
        // Peers do not learn correctIndex until reveal (host keeps it locally).
        this.triviaCurrent = {
          id: msg.id,
          index: msg.index,
          question: msg.q,
          options: msg.opts,
          counts: msg.opts.map(() => 0),
          correctIndex: this.isHost() && msg.ci != null ? msg.ci : null,
          open: true,
          revealed: false,
          at: msg.at
        }
        this.triviaQuestionSeq = Math.max(this.triviaQuestionSeq, msg.index)
        this.emit()
        return
      }
      case 'trivia_vote': {
        if (!this.isHost()) return
        const tq = this.triviaCurrent
        if (!tq || !tq.open || tq.id !== msg.id) return
        this.applyTriviaVoteAsHost(tq, msg.a, msg.i)
        this.emit()
        void this.send({ t: 'trivia_sync', current: this.cloneTriviaForWire(tq), at: Date.now() })
        return
      }
      case 'trivia_sync': {
        if (!fromHost) return
        this.triviaCurrent = msg.current
        if (msg.current) {
          this.triviaQuestionSeq = Math.max(this.triviaQuestionSeq, msg.current.index)
        }
        this.emit()
        return
      }
      case 'trivia_reveal': {
        if (!fromHost) return
        if (this.triviaCurrent?.id === msg.id) {
          this.triviaCurrent.open = false
          this.triviaCurrent.revealed = true
          this.triviaCurrent.closedAt = msg.at
          if (msg.counts.length === this.triviaCurrent.options.length) {
            this.triviaCurrent.counts = [...msg.counts]
          }
          if (msg.ci != null && msg.ci >= 0 && msg.ci < this.triviaCurrent.options.length) {
            this.triviaCurrent.correctIndex = msg.ci
          }
        }
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

  private applyTriviaVoteAsHost(tq: LiveTriviaQuestion, voter: string, optionIndex: number): void {
    const a = voter.trim().toLowerCase()
    if (!/^0x[a-f0-9]{40}$/.test(a)) return
    if (optionIndex < 0 || optionIndex >= tq.options.length) return
    if (!tq.voters) tq.voters = []
    if (tq.voters.includes(a)) return
    tq.voters.push(a)
    tq.counts[optionIndex] = (tq.counts[optionIndex] ?? 0) + 1
  }

  private archiveTriviaCurrent(): void {
    const tq = this.triviaCurrent
    if (!tq) return
    tq.open = false
    if (!tq.closedAt) tq.closedAt = Date.now()
    // Keep revealed flag as-is (host may archive without reveal).
    this.triviaHistory.push({
      ...tq,
      options: [...tq.options],
      counts: [...tq.counts],
      voters: tq.voters ? [...tq.voters] : undefined
    })
    if (this.triviaHistory.length > 100) this.triviaHistory.shift()
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

  private cloneTriviaForWire(tq: LiveTriviaQuestion): LiveTriviaQuestion {
    return {
      id: tq.id,
      index: tq.index,
      question: tq.question,
      options: [...tq.options],
      counts: [...tq.counts],
      // Only share correct answer after reveal.
      correctIndex: tq.revealed ? tq.correctIndex : null,
      open: tq.open,
      revealed: tq.revealed,
      at: tq.at,
      closedAt: tq.closedAt
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
      qaOn: this.qaActive,
      qa: this.qaInbox.filter((q) => !q.dismissed).slice(0, 40),
      triviaOn: this.triviaActive,
      triviaCurrent: this.triviaCurrent ? this.cloneTriviaForWire(this.triviaCurrent) : null,
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

function csvEsc(value: string): string {
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}
