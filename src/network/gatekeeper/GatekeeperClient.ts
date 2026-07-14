import type { AuthIdentity } from '@dcl/crypto/dist/types'
import signedFetch from 'decentraland-crypto-fetch'
import { isParcelPointer, normalizePointer } from '../catalyst/pointer'

export const GATEKEEPER_URL = 'https://comms-gatekeeper.decentraland.org'

export type SceneAdapterParams = {
  sceneId: string
  parcel: string
  realmName: string
  isWorld?: boolean
}

export type GetSceneAdapterResult =
  | { ok: true; adapter: string }
  | { ok: false; status: number; error: string; customMessage?: string }

function gatekeeperErrorFields(body: unknown): { error: string; customMessage?: string } {
  if (!body || typeof body !== 'object') {
    return { error: 'gatekeeper_error' }
  }

  const record = body as Record<string, unknown>
  const error =
    typeof record.error === 'string' && record.error.trim()
      ? record.error.trim()
      : 'gatekeeper_error'
  const customMessage =
    typeof record.customMessage === 'string' && record.customMessage.trim()
      ? record.customMessage.trim()
      : undefined

  return { error, customMessage }
}

export async function getSceneAdapter(
  identity: AuthIdentity,
  params: SceneAdapterParams,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<GetSceneAdapterResult> {
  const url = `${gatekeeperUrl.replace(/\/$/, '')}/get-scene-adapter`
  /**
   * Companion uses empty body `{}` + metadata { signer, sceneId, parcel, realmName }.
   * Nested world realm metadata is for `/scene-stream-access` only.
   */
  const metadata = {
    signer: 'decentraland-kernel-scene',
    sceneId: params.sceneId,
    parcel: params.parcel,
    realmName: params.realmName,
    isWorld: params.isWorld ?? false
  }

  let res: Response
  try {
    res = await signedFetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({}),
      identity,
      metadata
    })
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, status: 503, error: `gatekeeper_unreachable: ${detail}` }
  }

  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const fields = gatekeeperErrorFields(body)
    return {
      ok: false,
      status: res.status,
      error: fields.error === 'gatekeeper_error' ? res.statusText || fields.error : fields.error,
      customMessage: fields.customMessage
    }
  }

  if (
    body &&
    typeof body === 'object' &&
    'adapter' in body &&
    typeof (body as { adapter: unknown }).adapter === 'string'
  ) {
    return { ok: true, adapter: (body as { adapter: string }).adapter }
  }

  return { ok: false, status: res.status, error: 'invalid_gatekeeper_response' }
}

export async function fetchSceneParticipants(
  pointer: string,
  realmName: string,
  gatekeeperUrl = GATEKEEPER_URL
): Promise<string[]> {
  const normalized = normalizePointer(pointer)
  const url = new URL(`${gatekeeperUrl.replace(/\/$/, '')}/scene-participants`)
  if (isParcelPointer(normalized)) {
    url.searchParams.set('pointer', normalized)
    url.searchParams.set('realm_name', realmName.trim() || 'main')
  } else {
    url.searchParams.set('realm_name', normalized)
  }

  const res = await fetch(url.toString(), { headers: { Accept: 'application/json' } })
  if (!res.ok) return []

  const body = (await res.json()) as { data?: { addresses?: unknown } }
  const raw = body.data?.addresses
  if (!Array.isArray(raw)) return []

  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry === 'string' && /^0x[a-fA-F0-9]{40}$/.test(entry.trim())) {
      out.push(entry.trim().toLowerCase())
    }
  }
  return out
}
