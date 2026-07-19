import type { LanguageCode, TranslationResult } from './types'

/**
 * DCL Unity Explorer endpoint:
 *   https://autotranslate-server.decentraland.{org|zone}/translate
 * CORS: access-control-allow-origin: *
 */
const DEFAULT_TRANSLATE_URL = 'https://autotranslate-server.decentraland.org/translate'

type SingleResponse = {
  detectedLanguage?: { confidence?: number; language?: string } | null
  translatedText?: string
}

type BatchResponse = {
  detectedLanguage?: Array<{ confidence?: number; language?: string } | null>
  translatedText?: string[]
}

export type TranslateProviderOptions = {
  url?: string
  timeoutMs?: number
}

export class DclTranslationProvider {
  private readonly url: string
  private readonly timeoutMs: number

  constructor(opts: TranslateProviderOptions = {}) {
    this.url = opts.url ?? DEFAULT_TRANSLATE_URL
    this.timeoutMs = opts.timeoutMs ?? 12_000
  }

  async translate(text: string, target: LanguageCode, signal?: AbortSignal): Promise<TranslationResult> {
    const body = {
      q: text,
      source: 'auto',
      target,
      format: 'text'
    }
    const json = await this.postJson<SingleResponse>(body, signal)
    const translated = typeof json.translatedText === 'string' ? json.translatedText : text
    const detected =
      json.detectedLanguage && typeof json.detectedLanguage.language === 'string'
        ? json.detectedLanguage.language
        : null
    return { translatedText: translated, detectedLanguage: detected, fromCache: false }
  }

  async translateBatch(
    texts: string[],
    target: LanguageCode,
    signal?: AbortSignal
  ): Promise<TranslationResult[]> {
    if (texts.length === 0) return []
    if (texts.length === 1) {
      const one = await this.translate(texts[0]!, target, signal)
      return [one]
    }
    const body = {
      q: texts,
      source: 'auto',
      target,
      format: 'text'
    }
    const json = await this.postJson<BatchResponse>(body, signal)
    const out = json.translatedText
    if (!Array.isArray(out) || out.length !== texts.length) {
      throw new Error('Batch translation response size mismatch')
    }
    return out.map((translatedText, i) => {
      const det = json.detectedLanguage?.[i]
      return {
        translatedText: typeof translatedText === 'string' ? translatedText : texts[i]!,
        detectedLanguage: det && typeof det.language === 'string' ? det.language : null,
        fromCache: false
      }
    })
  }

  private async postJson<T>(body: unknown, outerSignal?: AbortSignal): Promise<T> {
    const controller = new AbortController()
    const onAbort = (): void => controller.abort()
    outerSignal?.addEventListener('abort', onAbort)
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const res = await fetch(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!res.ok) {
        throw new Error(`Translate HTTP ${res.status}`)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
      outerSignal?.removeEventListener('abort', onAbort)
    }
  }
}

export const dclTranslationProvider = new DclTranslationProvider()
