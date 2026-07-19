import { isTrivialMessage, shouldAutoTranslate } from './policy'
import { processAndTranslate, requiresProcessing } from './processor'
import { dclTranslationProvider, type DclTranslationProvider } from './provider'
import { chatTranslationSettings } from './settings'
import type {
  LanguageCode,
  MessageTranslation,
  TranslationResult,
  TranslationState,
  TranslationUpdateEvent
} from './types'

const CACHE_CAP = 200
const MEMORY_CAP = 200
const GLOBAL_INFLIGHT = 8

type CacheKey = string

function cacheKey(messageId: string, lang: LanguageCode): CacheKey {
  return `${messageId}\0${lang}`
}

type Listener = (event: TranslationUpdateEvent) => void

export type TranslateRequestOptions = {
  /**
   * When true (default), a second manual click on an already-shown translation
   * reverts to original. Auto-translate / backfill must pass false.
   */
  allowToggle?: boolean
}

/**
 * Chat translation orchestrator — mirrors Unity Explorer TranslationService:
 * policy → memory Pending → cache / processor+provider → Success|Failed → events.
 */
export class ChatTranslationService {
  private readonly provider: DclTranslationProvider
  private readonly cache = new Map<CacheKey, TranslationResult>()
  private readonly memory = new Map<string, MessageTranslation>()
  private readonly listeners = new Set<Listener>()
  private readonly inflight = new Map<string, Promise<void>>()
  private globalSlots = GLOBAL_INFLIGHT
  private readonly waiters: Array<() => void> = []

  constructor(provider: DclTranslationProvider = dclTranslationProvider) {
    this.provider = provider
  }

  onUpdate(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get(messageId: string): MessageTranslation | undefined {
    return this.memory.get(messageId)
  }

  /** Display text for a message, given the stored original. */
  displayText(messageId: string, originalText: string): string {
    const t = this.memory.get(messageId)
    if (!t || t.state !== 'success' || t.showingOriginal || !t.translatedText) return originalText
    return t.translatedText
  }

  isShowingTranslation(messageId: string): boolean {
    const t = this.memory.get(messageId)
    return Boolean(t && t.state === 'success' && !t.showingOriginal && t.translatedText)
  }

  getState(messageId: string): TranslationState {
    return this.memory.get(messageId)?.state ?? 'original'
  }

  /** Auto path for newly received remote text messages. */
  processIncoming(opts: {
    messageId: string
    text: string
    channelKey: string
    isSelf: boolean
    isImage: boolean
  }): void {
    const auto = chatTranslationSettings.getAutoTranslate(opts.channelKey)
    if (
      !shouldAutoTranslate({
        text: opts.text,
        channelKey: opts.channelKey,
        autoEnabled: auto,
        isSelf: opts.isSelf,
        isImage: opts.isImage
      })
    ) {
      return
    }
    void this.translateManual(opts.messageId, opts.text, { allowToggle: false })
  }

  async translateManual(
    messageId: string,
    originalText: string,
    opts: TranslateRequestOptions = {}
  ): Promise<void> {
    if (!messageId || isTrivialMessage(originalText)) return
    const allowToggle = opts.allowToggle !== false

    const existing = this.memory.get(messageId)
    if (existing?.state === 'pending') return

    if (allowToggle && existing?.state === 'success' && !existing.showingOriginal) {
      this.revertToOriginal(messageId)
      return
    }

    // Restore previously translated text without a network round-trip.
    if (existing?.state === 'success' && existing.translatedText) {
      if (existing.showingOriginal || !allowToggle) {
        existing.showingOriginal = false
        this.publish(existing)
        return
      }
    }

    const target = chatTranslationSettings.getPreferredLanguage()
    const entry: MessageTranslation = {
      messageId,
      originalText,
      translatedText: existing?.translatedText ?? null,
      state: 'pending',
      showingOriginal: false,
      detectedLanguage: existing?.detectedLanguage ?? null,
      targetLanguage: target
    }
    this.setMemory(messageId, entry)
    this.publish(entry)

    const run = this.runTranslate(messageId, originalText, target)
    this.inflight.set(messageId, run)
    try {
      await run
    } finally {
      this.inflight.delete(messageId)
    }
  }

  revertToOriginal(messageId: string): void {
    const entry = this.memory.get(messageId)
    if (!entry) return
    entry.showingOriginal = true
    if (entry.state === 'success' && entry.translatedText) {
      this.publish(entry)
      return
    }
    entry.state = 'original'
    this.publish(entry)
  }

  clearMessage(messageId: string): void {
    this.memory.delete(messageId)
    for (const key of [...this.cache.keys()]) {
      if (key.startsWith(`${messageId}\0`)) this.cache.delete(key)
    }
  }

  private async runTranslate(
    messageId: string,
    originalText: string,
    target: LanguageCode
  ): Promise<void> {
    const ck = cacheKey(messageId, target)
    const cached = this.cache.get(ck)
    if (cached) {
      this.applySuccess(messageId, originalText, target, { ...cached, fromCache: true })
      return
    }

    await this.acquireSlot()
    try {
      const result = requiresProcessing(originalText)
        ? await processAndTranslate(originalText, target, this.provider)
        : await this.provider.translate(originalText, target)

      // Skip no-op when source language matches preferred target.
      if (
        result.detectedLanguage &&
        result.detectedLanguage.toLowerCase() === target.toLowerCase()
      ) {
        this.applySuccess(messageId, originalText, target, {
          translatedText: originalText,
          detectedLanguage: result.detectedLanguage,
          fromCache: false
        })
        return
      }
      this.cacheSet(ck, result)
      this.applySuccess(messageId, originalText, target, result)
    } catch (err) {
      const entry = this.memory.get(messageId)
      if (!entry) return
      entry.state = 'failed'
      entry.error = err instanceof Error ? err.message : String(err)
      this.publish(entry)
    } finally {
      this.releaseSlot()
    }
  }

  private applySuccess(
    messageId: string,
    originalText: string,
    target: LanguageCode,
    result: TranslationResult
  ): void {
    const entry: MessageTranslation = {
      messageId,
      originalText,
      translatedText: result.translatedText,
      state: 'success',
      showingOriginal: false,
      detectedLanguage: result.detectedLanguage,
      targetLanguage: target
    }
    this.setMemory(messageId, entry)
    this.publish(entry)
  }

  private setMemory(messageId: string, entry: MessageTranslation): void {
    if (this.memory.has(messageId)) this.memory.delete(messageId)
    this.memory.set(messageId, entry)
    while (this.memory.size > MEMORY_CAP) {
      const oldest = this.memory.keys().next().value
      if (oldest === undefined) break
      this.memory.delete(oldest)
    }
  }

  private cacheSet(key: CacheKey, result: TranslationResult): void {
    if (this.cache.has(key)) this.cache.delete(key)
    this.cache.set(key, result)
    while (this.cache.size > CACHE_CAP) {
      const oldest = this.cache.keys().next().value
      if (oldest === undefined) break
      this.cache.delete(oldest)
    }
  }

  private publish(translation: MessageTranslation): void {
    const event: TranslationUpdateEvent = {
      messageId: translation.messageId,
      translation: { ...translation }
    }
    for (const listener of this.listeners) listener(event)
  }

  private acquireSlot(): Promise<void> {
    if (this.globalSlots > 0) {
      this.globalSlots -= 1
      return Promise.resolve()
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.globalSlots -= 1
        resolve()
      })
    })
  }

  private releaseSlot(): void {
    this.globalSlots += 1
    const next = this.waiters.shift()
    if (next) next()
  }
}

export const chatTranslationService = new ChatTranslationService()
