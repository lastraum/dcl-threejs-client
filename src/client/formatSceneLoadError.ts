export type SceneLoadErrorMessage = {
  title: string
  detail: string
}

/** User-facing copy for scene / world resolution failures (console keeps the raw Error). */
export function formatSceneLoadError(raw: string): SceneLoadErrorMessage {
  const trimmed = raw.trim()
  // Empty parcels resolve as synthetic primaries now — keep a soft message if an older
  // client/error string still surfaces.
  const emptyParcel = trimmed.match(/No deployed scene at parcel\s+(-?\d+)\s*,\s*(-?\d+)/i)
  if (emptyParcel) {
    const x = emptyParcel[1]!
    const y = emptyParcel[2]!
    return {
      title: 'Empty land',
      detail: `No deployed scene at ${x},${y}. You should still be able to walk empty land / roads — try reloading, or open Genesis Plaza (0,0) or a world (e.g. /lastslice.dcl.eth).`
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

  if (/SDK6_UNSUPPORTED/i.test(trimmed)) {
    const name = trimmed.match(/"([^"]+)"/)?.[1]
    const who = name ? `"${name}" is` : 'This location is'
    return {
      title: 'SDK6 scene not supported',
      detail:
        `${who} a classic SDK6 / Builder scene that could not be opened as empty land or roads. ` +
        'Genesis open roads and empty parcels should load as walkable land; try another SDK7 parcel or a world such as /lastslice.dcl.eth.'
    }
  }

  return {
    title: "Couldn't load this location",
    detail: trimmed || 'Something went wrong while loading. Try another destination.'
  }
}