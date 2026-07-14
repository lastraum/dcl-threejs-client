import { patchSceneBundle } from '../shim/worker/pointerEventColliderCheckerPatch'

export type SceneBundleMirrorMeta = {
  entityId: string
  commsPointer: string
  title: string
  hash: string
  scriptUrl: string
  code: string
}

/**
 * Dev-only — POST the fetched scene script to Vite `sceneBundleMirrorPlugin`
 * which writes under `dev/scene-bundles/`. Pure inspection aid; never blocks load.
 *
 * Opt-in only (avoids noisy 404 when the plugin isn't running):
 *   localStorage.mirrorSceneBundle = '1'
 * or URL `?mirrorscenebundle`
 */
export function mirrorSceneBundle(meta: SceneBundleMirrorMeta): void {
  if (!import.meta.env.DEV) return
  if (typeof window === 'undefined') return
  try {
    const params = new URLSearchParams(window.location.search)
    const want =
      params.has('mirrorscenebundle') || localStorage.getItem('mirrorSceneBundle') === '1'
    if (!want) return
  } catch {
    return
  }

  const patched = patchSceneBundle(meta.code)
  void fetch('/api/mirror-scene-bundle', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...meta,
      patched,
      mirroredAt: new Date().toISOString()
    })
  }).catch(() => {
    /* never block scene load */
  })
}
