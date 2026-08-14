import { APP_VERSION } from '../../client/appVersion'
import { PETBARN_MAX_GLB_BYTES, PETBARN_MAX_THUMB_BYTES } from './constants'
import { petBarnDispatchUrl } from './config'
import { compressPetBarnThumbnail } from './thumbCompress'
import type {
  DeletePetBarnInput,
  SubmitPetBarnInput,
  SubmitPetBarnResult,
  UpdatePetBarnInput
} from './types'

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(2)} MB`
}

export async function submitPetBarnListing(
  input: SubmitPetBarnInput
): Promise<SubmitPetBarnResult> {
  const dispatchUrl = petBarnDispatchUrl()
  if (!dispatchUrl) {
    return { ok: false, error: 'Pet Barn publish is disabled.' }
  }

  const petName = input.petName.trim()
  const creatorName = input.creatorName.trim()
  if (!petName) return { ok: false, error: 'Pet name is required' }
  if (!creatorName) return { ok: false, error: 'Creator name is required' }
  if (input.type !== 'walking' && input.type !== 'flying') {
    return { ok: false, error: 'Type must be walking or flying' }
  }
  if (!input.glb || input.glb.size <= 0) {
    return { ok: false, error: 'GLB file is required' }
  }
  if (input.glb.size > PETBARN_MAX_GLB_BYTES) {
    return {
      ok: false,
      error: `GLB must be ≤ ${formatBytes(PETBARN_MAX_GLB_BYTES)} (got ${formatBytes(input.glb.size)})`
    }
  }
  const glbName = input.glb.name.toLowerCase()
  if (!glbName.endsWith('.glb') && !glbName.endsWith('.gltf')) {
    return { ok: false, error: 'Only .glb models can be published' }
  }
  if (!input.thumb || input.thumb.size <= 0) {
    return { ok: false, error: 'Thumbnail image is required' }
  }

  let thumbBlob: Blob
  try {
    thumbBlob = await compressPetBarnThumbnail(input.thumb, PETBARN_MAX_THUMB_BYTES)
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Thumbnail compress failed'
    }
  }
  if (thumbBlob.size > PETBARN_MAX_THUMB_BYTES) {
    return {
      ok: false,
      error: `Thumbnail still over ${formatBytes(PETBARN_MAX_THUMB_BYTES)} after compress`
    }
  }

  const form = new FormData()
  form.set('petName', petName)
  form.set('creatorName', creatorName)
  form.set('type', input.type)
  form.set('clientVersion', APP_VERSION)
  if (input.wallet?.trim()) form.set('wallet', input.wallet.trim())
  form.set('file', input.glb, input.glb.name || 'pet.glb')
  const thumbName =
    thumbBlob.type === 'image/jpeg'
      ? 'thumb.jpg'
      : thumbBlob.type === 'image/png'
        ? 'thumb.png'
        : 'thumb.webp'
  form.set('thumb', thumbBlob, thumbName)

  try {
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' }
    })
    const contentType = res.headers.get('content-type') ?? ''
    let body: {
      error?: string
      id?: string
      issue_url?: string
      message?: string
    } = {}
    if (contentType.includes('application/json')) {
      try {
        body = (await res.json()) as typeof body
      } catch {
        /* ignore */
      }
    } else {
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        return { ok: false, error: text.trim() || `Publish failed (${res.status})` }
      }
    }
    if (!res.ok) {
      const raw = body.error || `Publish failed (${res.status})`
      return { ok: false, error: friendlyPublishError(raw, res.status) }
    }
    if (!body.id) {
      return { ok: false, error: 'Publish succeeded but no id returned' }
    }
    return {
      ok: true,
      id: body.id,
      issueUrl: body.issue_url,
      message: body.message
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error'
    }
  }
}

function friendlyPublishError(raw: string, status: number): string {
  const msg = raw.trim() || `Publish failed (${status})`
  const lower = msg.toLowerCase()
  if (
    status === 401 ||
    lower.includes('bad credentials') ||
    lower.includes('requires authentication')
  ) {
    return (
      'GitHub rejected the publish token (Bad credentials). ' +
      'In Cloudflare → Worker → Settings → Secrets, set PETBARN_GITHUB_TOKEN to a valid ' +
      'fine-grained PAT with Contents: Read/Write on lastraum/petbarn, then redeploy the Worker.'
    )
  }
  if (status === 403 || lower.includes('resource not accessible') || lower.includes('forbidden')) {
    return (
      'GitHub denied write access. Check that PETBARN_GITHUB_TOKEN can write to ' +
      'lastraum/petbarn (Contents: Read and write) and that the secret name is exact.'
    )
  }
  if (status === 503 || lower.includes('petbarn_github_token secret not set')) {
    return (
      'Publish Worker is missing PETBARN_GITHUB_TOKEN. Add it under Cloudflare Worker secrets and redeploy.'
    )
  }
  if (lower.includes('outside the allowed window') || lower.includes('freshness')) {
    return 'Signature expired — try again (requests must be signed within a few minutes).'
  }
  return msg
}

async function postDispatchForm(
  form: FormData,
  failTitle: string
): Promise<SubmitPetBarnResult> {
  const dispatchUrl = petBarnDispatchUrl()
  if (!dispatchUrl) {
    return { ok: false, error: 'Pet Barn publish is disabled.' }
  }
  try {
    const res = await fetch(dispatchUrl, {
      method: 'POST',
      body: form,
      headers: { Accept: 'application/json' }
    })
    const contentType = res.headers.get('content-type') ?? ''
    let body: {
      error?: string
      id?: string
      issue_url?: string
      message?: string
    } = {}
    if (contentType.includes('application/json')) {
      try {
        body = (await res.json()) as typeof body
      } catch {
        /* ignore */
      }
    } else {
      const text = await res.text().catch(() => '')
      if (!res.ok) {
        return { ok: false, error: text.trim() || `${failTitle} (${res.status})` }
      }
    }
    if (!res.ok) {
      const raw = body.error || `${failTitle} (${res.status})`
      return { ok: false, error: friendlyPublishError(raw, res.status) }
    }
    if (!body.id) {
      return { ok: false, error: `${failTitle}: no id returned` }
    }
    return {
      ok: true,
      id: body.id,
      issueUrl: body.issue_url,
      message: body.message
    }
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : 'Network error'
    }
  }
}

async function prepareThumb(thumb: File | Blob): Promise<{ blob: Blob; name: string } | { error: string }> {
  let thumbBlob: Blob
  try {
    thumbBlob = await compressPetBarnThumbnail(thumb, PETBARN_MAX_THUMB_BYTES)
  } catch (err) {
    return {
      error: err instanceof Error ? err.message : 'Thumbnail compress failed'
    }
  }
  if (thumbBlob.size > PETBARN_MAX_THUMB_BYTES) {
    return {
      error: `Thumbnail still over ${formatBytes(PETBARN_MAX_THUMB_BYTES)} after compress`
    }
  }
  const thumbName =
    thumbBlob.type === 'image/jpeg'
      ? 'thumb.jpg'
      : thumbBlob.type === 'image/png'
        ? 'thumb.png'
        : 'thumb.webp'
  return { blob: thumbBlob, name: thumbName }
}

function validateGlb(glb: File): string | null {
  if (!glb || glb.size <= 0) return 'GLB file is required'
  if (glb.size > PETBARN_MAX_GLB_BYTES) {
    return `GLB must be ≤ ${formatBytes(PETBARN_MAX_GLB_BYTES)} (got ${formatBytes(glb.size)})`
  }
  const glbName = glb.name.toLowerCase()
  if (!glbName.endsWith('.glb') && !glbName.endsWith('.gltf')) {
    return 'Only .glb models can be published'
  }
  return null
}

/** Replace an existing Barn listing (owner or admin signature required by the Action). */
export async function updatePetBarnListing(input: UpdatePetBarnInput): Promise<SubmitPetBarnResult> {
  const petName = input.petName.trim()
  const creatorName = input.creatorName.trim()
  if (!petName) return { ok: false, error: 'Pet name is required' }
  if (!creatorName) return { ok: false, error: 'Creator name is required' }
  if (input.type !== 'walking' && input.type !== 'flying') {
    return { ok: false, error: 'Type must be walking or flying' }
  }
  const glbErr = validateGlb(input.glb)
  if (glbErr) return { ok: false, error: glbErr }
  if (!input.thumb || input.thumb.size <= 0) {
    return { ok: false, error: 'Thumbnail image is required' }
  }
  const targetId = input.targetId.trim()
  if (!targetId) return { ok: false, error: 'Missing listing id' }
  if (!input.signature?.startsWith('0x')) {
    return { ok: false, error: 'Missing wallet signature' }
  }
  if (!/^[0-9a-f]{64}$/i.test(input.glbSha256)) {
    return { ok: false, error: 'Invalid GLB hash' }
  }

  const thumb = await prepareThumb(input.thumb)
  if ('error' in thumb) return { ok: false, error: thumb.error }

  const form = new FormData()
  form.set('action', 'update')
  form.set('targetId', targetId)
  form.set('signature', input.signature)
  form.set('timestampMs', String(input.timestampMs))
  form.set('glbSha256', input.glbSha256.toLowerCase())
  form.set('petName', petName)
  form.set('creatorName', creatorName)
  form.set('type', input.type)
  form.set('clientVersion', APP_VERSION)
  if (input.wallet?.trim()) form.set('wallet', input.wallet.trim())
  form.set('file', input.glb, input.glb.name || 'pet.glb')
  form.set('thumb', thumb.blob, thumb.name)

  return postDispatchForm(form, 'Update failed')
}

/** Remove a Barn listing (owner or admin signature; Action deploys tombstone + drops catalog row). */
export async function deletePetBarnListing(input: DeletePetBarnInput): Promise<SubmitPetBarnResult> {
  const targetId = input.targetId.trim()
  if (!targetId) return { ok: false, error: 'Missing listing id' }
  if (!input.signature?.startsWith('0x')) {
    return { ok: false, error: 'Missing wallet signature' }
  }

  const form = new FormData()
  form.set('action', 'delete')
  form.set('targetId', targetId)
  form.set('signature', input.signature)
  form.set('timestampMs', String(input.timestampMs))
  form.set('clientVersion', APP_VERSION)
  if (input.wallet?.trim()) form.set('wallet', input.wallet.trim())

  return postDispatchForm(form, 'Delete failed')
}
