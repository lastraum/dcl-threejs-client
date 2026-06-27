import type { CustomAvatarFormat } from '../vrm/constants'

/** Console + Help debug trail for DAV / remote ODK avatar sync. */
export function odkNetInfo(message: string, detail?: Record<string, unknown>): void {
  if (detail) console.info(`[odk-net] ${message}`, detail)
  else console.info(`[odk-net] ${message}`)
}

export function odkNetWarn(message: string, detail?: Record<string, unknown>): void {
  if (detail) console.warn(`[odk-net] ${message}`, detail)
  else console.warn(`[odk-net] ${message}`)
}

export function shortAddr(address: string): string {
  const a = address.toLowerCase()
  return a.length > 10 ? `${a.slice(0, 8)}…` : a
}

export function shortHash(hash: string | null | undefined): string {
  if (!hash) return '—'
  const h = hash.toLowerCase()
  return h.length > 12 ? `${h.slice(0, 12)}…` : h
}

export function formatTag(format: CustomAvatarFormat | null | undefined): string {
  return format === 'odk' ? 'odk' : format === 'vrm' ? 'vrm' : '—'
}