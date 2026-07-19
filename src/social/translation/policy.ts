/** Skip auto-translate for empty / pure-URL / pure-slash-command messages. */
const URL_ONLY = /^https?:\/\/\S+$/i
const SLASH_COMMAND = /^\/\S+/

export function isTrivialMessage(text: string): boolean {
  const t = text.trim()
  if (!t) return true
  if (URL_ONLY.test(t)) return true
  if (SLASH_COMMAND.test(t) && !/\s/.test(t.slice(1))) return true
  return false
}

export function shouldAutoTranslate(opts: {
  text: string
  channelKey: string
  autoEnabled: boolean
  isSelf: boolean
  isImage: boolean
}): boolean {
  if (!opts.autoEnabled) return false
  if (opts.isSelf || opts.isImage) return false
  if (isTrivialMessage(opts.text)) return false
  return Boolean(opts.channelKey)
}
