import signedFetch from 'decentraland-crypto-fetch'
import type { AuthIdentity } from '@dcl/crypto/dist/types'
import type { DclEvent } from './dclEvents'

const EVENTS_API = 'https://events.decentraland.org/api'

export type CreateEventPayload = {
  name: string
  description?: string | null
  image?: string | null
  image_vertical?: string | null
  start_at: string
  duration: number
  all_day?: boolean
  x: number
  y: number
  world?: boolean
  url?: string
  contact?: string | null
  community_id?: string | null
  recurrent?: boolean
  recurrent_frequency?: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY' | null
  recurrent_interval?: number
  recurrent_until?: string | null
}

export type UploadedPoster = {
  url: string
  size: number
  type: string
}

function parseApiError(body: unknown, status: number): string {
  if (body && typeof body === 'object') {
    const err = (body as { error?: unknown; message?: unknown }).error ?? (body as { message?: unknown }).message
    if (typeof err === 'string' && err.trim()) return err
  }
  return `Events API error (${status})`
}

/** Parse hh:mm or h:mm into milliseconds (max 24h). */
export function parseDurationMs(raw: string): number | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(trimmed)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || minutes >= 60) return null
  const ms = (hours * 60 + minutes) * 60_000
  if (ms <= 0 || ms > 86_400_000) return null
  return ms
}

/** Combine local date + time inputs into ISO 8601 UTC. */
export function combineDateAndTimeIso(dateValue: string, timeValue: string): string | null {
  if (!dateValue || !timeValue) return null
  const local = new Date(`${dateValue}T${timeValue}`)
  if (!Number.isFinite(local.getTime())) return null
  return local.toISOString()
}

export async function uploadEventPoster(
  file: File,
  identity: AuthIdentity,
  vertical = false
): Promise<UploadedPoster> {
  const endpoint = vertical ? `${EVENTS_API}/poster-vertical` : `${EVENTS_API}/poster`
  const form = new FormData()
  form.append('poster', file, file.name)

  const res = await signedFetch(endpoint, {
    method: 'POST',
    body: form,
    identity
  })

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    data?: UploadedPoster
    error?: string
  }

  if (!res.ok || !body.ok || !body.data?.url) {
    throw new Error(body.error ?? parseApiError(body, res.status))
  }
  return body.data
}

export async function createDclEvent(
  payload: CreateEventPayload,
  identity: AuthIdentity
): Promise<DclEvent> {
  const res = await signedFetch(`${EVENTS_API}/events`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload),
    identity
  })

  const body = (await res.json().catch(() => ({}))) as {
    ok?: boolean
    data?: DclEvent
    error?: string
  }

  if (!res.ok || !body.ok || !body.data) {
    throw new Error(body.error ?? parseApiError(body, res.status))
  }
  return body.data
}