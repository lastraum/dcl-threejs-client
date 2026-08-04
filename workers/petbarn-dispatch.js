/**
 * Cloudflare Worker — client Pet Barn publish → GitHub queue on lastraum/petbarn.
 *
 * Dashboard: create Worker, paste this file, Deploy.
 * Secrets:
 *   PETBARN_GITHUB_TOKEN = fine-grained PAT (Contents: Read and write on petbarn repo)
 * Vars (optional):
 *   PETBARN_REPO = lastraum/petbarn
 *   PETBARN_BRANCH = main
 *
 * POST multipart/form-data:
 *   petName, creatorName, type (walking|flying), file (glb ≤2MB), thumb (image ≤500KB)
 *   optional: wallet, clientVersion
 *
 * Update / delete (existing listings):
 *   action = update | delete (default create), targetId = listing id,
 *   signature, timestampMs, glbSha256 (update only) — personal_sign over
 *   `petbarn:v1:<action>:<targetId>:<glbSha256|none>:<timestampMs>`.
 *   update also takes file + thumb (+ petName/creatorName/type for the
 *   refreshed listing); delete takes no files.
 *   The Worker validates shape + timestamp freshness and forwards meta.auth —
 *   signature verification runs in the repo's deploy Action
 *   (scripts/verify-action.mjs), so this file stays dependency-free.
 *
 * Vars (optional):
 *   PETBARN_AUTH_MAX_AGE_MS — max |now − timestampMs| for update/delete
 *     (default 600000 = 10 minutes). Deploy Action should enforce the same.
 */

const DEFAULT_REPO = 'lastraum/petbarn'
const DEFAULT_BRANCH = 'main'
const MAX_GLB = 2 * 1024 * 1024
const MAX_THUMB = 500 * 1024
/** Default window for signed update/delete requests (ms). */
const DEFAULT_AUTH_MAX_AGE_MS = 10 * 60 * 1000
const VALID_TYPES = new Set(['walking', 'flying'])

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type'
}

function json(data, status = 200) {
  return Response.json(data, { status, headers: CORS })
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32) || 'pet'
}

function todayStamp() {
  const d = new Date()
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

function rand4() {
  return Math.random().toString(36).slice(2, 6)
}

function bytesToBase64(bytes) {
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

function thumbExt(file) {
  const name = (file.name || '').toLowerCase()
  if (name.endsWith('.webp')) return 'webp'
  if (name.endsWith('.png')) return 'png'
  if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'jpg'
  const t = (file.type || '').toLowerCase()
  if (t.includes('webp')) return 'webp'
  if (t.includes('png')) return 'png'
  if (t.includes('jpeg') || t.includes('jpg')) return 'jpg'
  return 'webp'
}

/**
 * Reject stale or far-future signed timestamps (replay / clock skew).
 * @returns {string|null} error message, or null if ok
 */
function authTimestampFreshnessError(timestampMs, maxAgeMs) {
  if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
    return 'timestampMs must be a positive number'
  }
  const now = Date.now()
  const skew = Math.abs(now - timestampMs)
  if (skew > maxAgeMs) {
    const ageSec = Math.round(skew / 1000)
    const maxSec = Math.round(maxAgeMs / 1000)
    return `timestampMs is outside the allowed window (±${maxSec}s; skew ${ageSec}s) — re-sign and retry`
  }
  return null
}

async function gh(token, path, init = {}) {
  const res = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'dcl-petbarn-dispatch-worker',
      ...(init.headers || {})
    }
  })
  const text = await res.text()
  let body = {}
  try {
    body = text ? JSON.parse(text) : {}
  } catch {
    body = { message: text }
  }
  return { res, body }
}

/**
 * Atomic multi-file commit via Git Data API.
 * files: [{ path, contentBase64 }]
 */
async function commitFiles(token, repo, branch, message, files) {
  const ref = await gh(token, `/repos/${repo}/git/ref/heads/${encodeURIComponent(branch)}`)
  if (!ref.res.ok) {
    throw Object.assign(new Error(ref.body.message || 'Failed to read branch ref'), {
      status: ref.res.status,
      body: ref.body
    })
  }
  const commitSha = ref.body.object?.sha
  if (!commitSha) throw new Error('Missing commit sha on branch ref')

  const commit = await gh(token, `/repos/${repo}/git/commits/${commitSha}`)
  if (!commit.res.ok) {
    throw Object.assign(new Error(commit.body.message || 'Failed to read commit'), {
      status: commit.res.status,
      body: commit.body
    })
  }
  const baseTree = commit.body.tree?.sha
  if (!baseTree) throw new Error('Missing base tree')

  const treeItems = []
  for (const f of files) {
    const blob = await gh(token, `/repos/${repo}/git/blobs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: f.contentBase64, encoding: 'base64' })
    })
    if (!blob.res.ok) {
      throw Object.assign(new Error(blob.body.message || `Blob failed for ${f.path}`), {
        status: blob.res.status,
        body: blob.body
      })
    }
    treeItems.push({
      path: f.path,
      mode: '100644',
      type: 'blob',
      sha: blob.body.sha
    })
  }

  const tree = await gh(token, `/repos/${repo}/git/trees`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base_tree: baseTree, tree: treeItems })
  })
  if (!tree.res.ok) {
    throw Object.assign(new Error(tree.body.message || 'Create tree failed'), {
      status: tree.res.status,
      body: tree.body
    })
  }

  const newCommit = await gh(token, `/repos/${repo}/git/commits`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message,
      tree: tree.body.sha,
      parents: [commitSha]
    })
  })
  if (!newCommit.res.ok) {
    throw Object.assign(new Error(newCommit.body.message || 'Create commit failed'), {
      status: newCommit.res.status,
      body: newCommit.body
    })
  }

  const updated = await gh(token, `/repos/${repo}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sha: newCommit.body.sha })
  })
  if (!updated.res.ok) {
    throw Object.assign(new Error(updated.body.message || 'Update ref failed'), {
      status: updated.res.status,
      body: updated.body
    })
  }

  return { commitSha: newCommit.body.sha }
}

async function createAuditIssue(token, repo, meta, paths) {
  const action = meta.action || 'create'
  const title = (
    action === 'create'
      ? `[pet] ${meta.petName} by ${meta.creatorName}`
      : `[pet-${action}] ${meta.targetId}${meta.petName ? ` → ${meta.petName}` : ''}`
  ).slice(0, 256)
  const body = [
    `### Pet Barn ${action === 'create' ? 'submission' : action}`,
    '',
    `- **id:** \`${meta.id}\``,
    meta.targetId ? `- **target listing:** \`${meta.targetId}\`` : null,
    meta.petName ? `- **petName:** ${meta.petName}` : null,
    meta.creatorName ? `- **creatorName:** ${meta.creatorName}` : null,
    meta.type ? `- **type:** ${meta.type}` : null,
    meta.sizeBytes ? `- **glb:** ${meta.sizeBytes} bytes` : null,
    meta.thumbnailSizeBytes ? `- **thumb:** ${meta.thumbnailSizeBytes} bytes` : null,
    meta.wallet ? `- **wallet:** \`${meta.wallet}\`` : null,
    meta.auth ? `- **auth:** signed, ts ${meta.auth.timestampMs} (verified by deploy Action)` : null,
    meta.clientVersion ? `- **client:** \`${meta.clientVersion}\`` : null,
    '',
    '### Queue paths',
    ...paths.map((p) => `- \`${p}\``),
    '',
    '_Auto-deploy runs via GitHub Action on `pets/queue/**`._'
  ]
    .filter(Boolean)
    .join('\n')

  const issue = await gh(token, `/repos/${repo}/issues`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body, labels: ['pet-submit'] })
  })
  // Non-fatal if labels missing or issues disabled
  if (!issue.res.ok) {
    return { ok: false, error: issue.body.message || 'issue failed' }
  }
  return { ok: true, number: issue.body.number, url: issue.body.html_url }
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS })
    }
    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed — POST only' }, 405)
    }

    // Trim: dashboard paste sometimes includes trailing newline/space → GitHub 401 Bad credentials
    const token = String(env.PETBARN_GITHUB_TOKEN || '').trim()
    if (!token) {
      return json(
        {
          error: 'PETBARN_GITHUB_TOKEN secret not set',
          hint: 'Worker Settings → Variables and Secrets → Add secret PETBARN_GITHUB_TOKEN, then Deploy'
        },
        503
      )
    }
    if (!token.startsWith('github_pat_') && !token.startsWith('ghp_')) {
      return json(
        {
          error:
            'PETBARN_GITHUB_TOKEN does not look like a GitHub PAT (expected github_pat_… or ghp_…). Re-create the secret and redeploy.'
        },
        503
      )
    }

    const repo = String(env.PETBARN_REPO || DEFAULT_REPO).trim()
    const branch = String(env.PETBARN_BRANCH || DEFAULT_BRANCH).trim() || 'main'
    const authMaxAgeMs = (() => {
      const raw = Number(env.PETBARN_AUTH_MAX_AGE_MS)
      if (Number.isFinite(raw) && raw >= 30_000 && raw <= 24 * 60 * 60 * 1000) return raw
      return DEFAULT_AUTH_MAX_AGE_MS
    })()

    let form
    try {
      form = await request.formData()
    } catch {
      return json({ error: 'Expected multipart/form-data' }, 400)
    }

    const petName = String(form.get('petName') || '').trim()
    const creatorName = String(form.get('creatorName') || '').trim()
    const type = String(form.get('type') || '').trim()
    const wallet = String(form.get('wallet') || '').trim().slice(0, 80) || undefined
    const clientVersion = String(form.get('clientVersion') || '').trim().slice(0, 40) || undefined
    const glb = form.get('file')
    const thumb = form.get('thumb')

    const action = String(form.get('action') || 'create').trim().toLowerCase()
    if (!['create', 'update', 'delete'].includes(action)) {
      return json({ error: 'action must be create, update or delete' }, 400)
    }

    // --- auth shape + freshness for update/delete (crypto verified by deploy Action) ---
    let targetId
    let auth
    if (action !== 'create') {
      targetId = String(form.get('targetId') || '').trim()
      if (!/^[a-z0-9][a-z0-9-]{2,80}$/i.test(targetId)) {
        return json({ error: `${action} requires a valid targetId` }, 400)
      }
      const signature = String(form.get('signature') || '').trim()
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) {
        return json({ error: `${action} requires signature (0x + 65 bytes hex)` }, 400)
      }
      const timestampMs = Number(form.get('timestampMs'))
      if (!Number.isFinite(timestampMs) || timestampMs <= 0) {
        return json({ error: `${action} requires numeric timestampMs` }, 400)
      }
      const freshnessErr = authTimestampFreshnessError(timestampMs, authMaxAgeMs)
      if (freshnessErr) {
        return json({ error: freshnessErr }, 400)
      }
      const glbSha256 = String(form.get('glbSha256') || '').trim().toLowerCase()
      if (action === 'update' && !/^[0-9a-f]{64}$/.test(glbSha256)) {
        return json({ error: 'update requires glbSha256 (hex sha256 of the GLB)' }, 400)
      }
      auth = {
        signature,
        timestampMs,
        glbSha256: action === 'update' ? glbSha256 : 'none'
      }
    }

    if (action !== 'delete') {
      if (petName.length < 1 || petName.length > 64) {
        return json({ error: 'petName must be 1–64 characters' }, 400)
      }
      if (creatorName.length < 1 || creatorName.length > 64) {
        return json({ error: 'creatorName must be 1–64 characters' }, 400)
      }
      if (!VALID_TYPES.has(type)) {
        return json({ error: 'type must be walking or flying' }, 400)
      }
      if (!(glb instanceof File) || glb.size <= 0) {
        return json({ error: 'file (GLB) is required' }, 400)
      }
      if (glb.size > MAX_GLB) {
        return json({ error: `GLB must be ≤ ${MAX_GLB} bytes (got ${glb.size})` }, 400)
      }
      const glbName = (glb.name || '').toLowerCase()
      if (!glbName.endsWith('.glb') && !glbName.endsWith('.gltf')) {
        return json({ error: 'file must be a .glb' }, 400)
      }
      if (!(thumb instanceof File) || thumb.size <= 0) {
        return json({ error: 'thumb (image) is required' }, 400)
      }
      if (thumb.size > MAX_THUMB) {
        return json({ error: `Thumbnail must be ≤ ${MAX_THUMB} bytes (got ${thumb.size})` }, 400)
      }
      const tType = (thumb.type || '').toLowerCase()
      if (tType && !tType.startsWith('image/')) {
        return json({ error: 'thumb must be an image' }, 400)
      }
    }

    const slug = action === 'delete' ? `del-${slugify(targetId)}` : slugify(petName)
    const id = `${todayStamp()}-${slug}-${rand4()}`
    const base = `pets/queue/${id}`
    const meta = {
      id,
      ...(action !== 'create' ? { action, targetId, auth } : {}),
      ...(action !== 'delete'
        ? {
            petName,
            creatorName,
            type,
            sizeBytes: glb.size,
            thumbnailSizeBytes: thumb.size
          }
        : {}),
      submittedAt: new Date().toISOString(),
      wallet,
      clientVersion
    }

    const files = []
    const paths = []
    if (action !== 'delete') {
      const glbBytes = new Uint8Array(await glb.arrayBuffer())
      const thumbBytes = new Uint8Array(await thumb.arrayBuffer())

      // basic glb magic: "glTF"
      if (glbBytes.length >= 4) {
        const magic = String.fromCharCode(glbBytes[0], glbBytes[1], glbBytes[2], glbBytes[3])
        if (magic !== 'glTF') {
          return json({ error: 'file does not look like a binary GLB (missing glTF header)' }, 400)
        }
      }
      const ext = thumbExt(thumb)
      paths.push(`${base}/pet.glb`, `${base}/thumb.${ext}`)
      files.push(
        { path: `${base}/pet.glb`, contentBase64: bytesToBase64(glbBytes) },
        { path: `${base}/thumb.${ext}`, contentBase64: bytesToBase64(thumbBytes) }
      )
    }
    paths.push(`${base}/meta.json`)
    files.push({
      path: `${base}/meta.json`,
      contentBase64: bytesToBase64(new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n'))
    })

    const commitLabel =
      action === 'create' ? `queue ${id} (${petName})` : `queue ${id} (${action} ${targetId})`
    try {
      await commitFiles(token, repo, branch, `petbarn: ${commitLabel}`, files)
    } catch (err) {
      const status = err?.status || 502
      return json(
        {
          error: err?.message || 'GitHub commit failed',
          github: err?.body || null
        },
        status >= 400 && status < 600 ? status : 502
      )
    }

    const issue = await createAuditIssue(token, repo, meta, paths).catch((e) => ({
      ok: false,
      error: e?.message || String(e)
    }))

    return json(
      {
        ok: true,
        id,
        paths,
        issue_url: issue?.url || null,
        issue_number: issue?.number || null,
        message: 'Queued for Worlds deploy. Catalog updates after GitHub Action finishes.'
      },
      201
    )
  }
}
