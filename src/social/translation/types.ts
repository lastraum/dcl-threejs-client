/** Preferred chat target languages (matches Unity Explorer ChatTranslationSettings). */
export type LanguageCode =
  | 'en'
  | 'es'
  | 'fr'
  | 'de'
  | 'ru'
  | 'pt'
  | 'it'
  | 'zh'
  | 'ja'
  | 'ko'

export const LANGUAGE_OPTIONS: ReadonlyArray<{ code: LanguageCode; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ru', label: 'Russian' },
  { code: 'pt', label: 'Portuguese' },
  { code: 'it', label: 'Italian' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' }
]

export type TranslationState = 'original' | 'pending' | 'success' | 'failed'

export type MessageTranslation = {
  messageId: string
  originalText: string
  translatedText: string | null
  state: TranslationState
  /** When true, UI shows original even if a successful translation exists. */
  showingOriginal: boolean
  detectedLanguage: string | null
  targetLanguage: LanguageCode
  error?: string
}

export type TranslationResult = {
  translatedText: string
  detectedLanguage: string | null
  fromCache: boolean
}

export type TranslationUpdateEvent = {
  messageId: string
  translation: MessageTranslation
}
