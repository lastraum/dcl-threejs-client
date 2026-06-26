import { patchSceneBundle } from '../shim/worker/pointerEventColliderCheckerPatch'

export type SceneBundleMirrorMeta = {
  entityId: string
  commsPointer: string
  title: string
  hash: string
  scriptUrl: string
  code: string
}

/** Dev-only — persist fetched scene scripts under `dev/scene-bundles/` for inspection. */
export function mirrorSceneBundle(meta: SceneBundleMirrorMeta): void {
  if (!import.meta.env.DEV) return
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
    /* dev convenience — never block scene load */
  })
}