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
 */

const DEFAULT_REPO = 'lastraum/petbarn'
const DEFAULT_BRANCH = 'main'
const MAX_GLB = 2 * 1024 * 1024
const MAX_THUMB = 500 * 1024
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
  const title = `[pet] ${meta.petName} by ${meta.creatorName}`.slice(0, 256)
  const body = [
    '### Pet Barn submission',
    '',
    `- **id:** \`${meta.id}\``,
    `- **petName:** ${meta.petName}`,
    `- **creatorName:** ${meta.creatorName}`,
    `- **type:** ${meta.type}`,
    `- **glb:** ${meta.sizeBytes} bytes`,
    `- **thumb:** ${meta.thumbnailSizeBytes} bytes`,
    meta.wallet ? `- **wallet:** \`${meta.wallet}\`` : null,
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

    const id = `${todayStamp()}-${slugify(petName)}-${rand4()}`
    const ext = thumbExt(thumb)
    const base = `pets/queue/${id}`
    const meta = {
      id,
      petName,
      creatorName,
      type,
      submittedAt: new Date().toISOString(),
      sizeBytes: glb.size,
      thumbnailSizeBytes: thumb.size,
      wallet,
      clientVersion
    }

    const glbBytes = new Uint8Array(await glb.arrayBuffer())
    const thumbBytes = new Uint8Array(await thumb.arrayBuffer())

    // basic glb magic: "glTF"
    if (glbBytes.length >= 4) {
      const magic = String.fromCharCode(glbBytes[0], glbBytes[1], glbBytes[2], glbBytes[3])
      if (magic !== 'glTF') {
        return json({ error: 'file does not look like a binary GLB (missing glTF header)' }, 400)
      }
    }

    const paths = [
      `${base}/pet.glb`,
      `${base}/thumb.${ext}`,
      `${base}/meta.json`
    ]

    try {
      await commitFiles(token, repo, branch, `petbarn: queue ${id} (${petName})`, [
        { path: paths[0], contentBase64: bytesToBase64(glbBytes) },
        { path: paths[1], contentBase64: bytesToBase64(thumbBytes) },
        {
          path: paths[2],
          contentBase64: bytesToBase64(new TextEncoder().encode(JSON.stringify(meta, null, 2) + '\n'))
        }
      ])
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
