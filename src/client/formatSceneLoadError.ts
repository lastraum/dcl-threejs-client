export type SceneLoadErrorMessage = {
  title: string
  detail: string
}

/** User-facing copy for scene / world resolution failures (console keeps the raw Error). */
export function formatSceneLoadError(raw: string): SceneLoadErrorMessage {
  const trimmed = raw.trim()
  const emptyParcel = trimmed.match(/No deployed scene at parcel\s+(-?\d+)\s*,\s*(-?\d+)/i)
  if (emptyParcel) {
    const x = emptyParcel[1]!
    const y = emptyParcel[2]!
    return {
      title: 'No scene at this parcel',
      detail: `Nothing is deployed at ${x},${y}. Pick a parcel with a scene on the map, try Genesis Plaza (0,0), or open a world (for example /lastslice.dcl.eth).`
    }
  }

  const worldMissing = trimmed.match(/World not found/i)
  if (worldMissing) {
    return {
      title: 'World not found',
      detail: trimmed.replace(/^World not found\s*/i, '') ||
        'Check the world name and try again.'
    }
  }

  return {
    title: "Couldn't load this location",
    detail: trimmed || 'Something went wrong while loading. Try another destination.'
  }
}