export type SceneLoadErrorMessage = {
  title: string
  detail: string
}

/** User-facing copy for scene / world resolution failures (console keeps the raw Error). */
export function formatSceneLoadError(raw: string): SceneLoadErrorMessage {
  const trimmed = raw.trim()
  // Legacy error string (pre empty-land synthetic scenes). Should not fire for empty
  // coords anymore — kept so old clients / residual paths still show a clear title.
  const emptyParcel = trimmed.match(/No deployed scene at parcel\s+(-?\d+)\s*,\s*(-?\d+)/i)
  if (emptyParcel) {
    const x = emptyParcel[1]!
    const y = emptyParcel[2]!
    return {
      title: 'Could not open this parcel',
      detail: `Failed to load ${x},${y}. Check your network and try again, or open Genesis Plaza (0,0) / a world (for example /lastslice.dcl.eth).`
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

  if (/PREVIEW_UNREACHABLE/i.test(trimmed)) {
    return {
      title: 'Hub preview not running',
      detail:
        trimmed.replace(/^PREVIEW_UNREACHABLE:\s*/i, '') ||
        'Start Preview in Creator Hub (or npm run start in the scene folder), then reload. ' +
          'If the browser asks to access apps on your device, click Allow.'
    }
  }

  if (/PREVIEW_EMPTY/i.test(trimmed)) {
    return {
      title: 'No scene on the preview server',
      detail:
        trimmed.replace(/^PREVIEW_EMPTY:\s*/i, '') ||
        'The preview server is up but has no scene entity. Confirm Hub Preview is running a scene.'
    }
  }

  if (/SDK6_UNSUPPORTED/i.test(trimmed)) {
    const name = trimmed.match(/"([^"]+)"/)?.[1]
    const who = name ? `"${name}" is` : 'This location is'
    return {
      title: 'SDK6 scene not supported',
      detail:
        `${who} a classic SDK6 / Builder scene. ` +
        'This client only runs SDK7 scenes (runtimeVersion 7). ' +
        'Try Genesis Plaza (0,0), another SDK7 parcel, or a world such as /lastslice.dcl.eth.'
    }
  }

  return {
    title: "Couldn't load this location",
    detail: trimmed || 'Something went wrong while loading. Try another destination.'
  }
}