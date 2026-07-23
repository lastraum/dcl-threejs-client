import type { CustomAvatarFormat } from '../vrm/constants'
import { clientDebugLog } from '../../client/debug/ClientDebugLog'

/** Console + Help debug trail for DAV / remote ODK avatar sync — opt-in only. */
export function odkNetInfo(message: string, detail?: Record<string, unknown>): void {
  const suffix = detail ? ` ${safeDetail(detail)}` : ''
  clientDebugLog.log('odk-net', `${message}${suffix}`)
}

export function odkNetWarn(message: string, detail?: Record<string, unknown>): void {
  const suffix = detail ? ` ${safeDetail(detail)}` : ''
  clientDebugLog.log('odk-net', `${message}${suffix}`, { level: 'warn' })
}

function safeDetail(detail: Record<string, unknown>): string {
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
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
