/**
 * Map load status strings to a monotonic 0–1 progress fraction (top bar).
 *
 * The asset-loading phase (0.38 → 0.80) is now driven by a numeric fraction
 * computed in `waitForSceneAssets` and passed via `LoadingScreen.setProgress()`.
 * This string parser only provides checkpoint gates for non-asset stages and
 * a lightweight fallback for the asset range.
 */
export function progressFromStatus(message: string, previous: number): number {
  const lower = message.toLowerCase()
  // Shaders checkpoint is later — do not treat it as bundle compile.
  if (lower.includes('compiling scene shaders')) {
    return Math.max(previous, 0.84)
  }
  // Bundle compile can take a minute; creep 35% → ~38% so the bar is not frozen.
  if (lower.includes('compiling') && (lower.includes('scene') || lower.includes('bundle'))) {
    const secMatch = message.match(/(\d+)\s*s\b/i)
    const sec = secMatch ? Number(secMatch[1]) : 0
    const creep = Math.min(0.028, (Math.max(0, sec) / 90) * 0.028)
    return Math.max(previous, 0.35 + creep)
  }

  const checkpoints: Array<[prefix: string, value: number]> = [
    ['Resolving destination', 0.04],
    ['Preparing scene', 0.06],
    ['Building world', 0.08],
    ['Setting up sky', 0.12],
    ['parcel', 0.18],
    ['Initialising physics', 0.24],
    ['Connecting profile', 0.28],
    ['Guest mode', 0.3],
    ['Profile loaded', 0.32],
    ['Booting scene script', 0.34],
    ['Fetching scene script', 0.345],
    ['compile-progress', 0.35],
    ['Scene script compiled', 0.36],
    ['Scene script running', 0.36],
    ['Loading scene assets', 0.38],
    ['Finishing scene load', 0.78],
    ['Scene ready', 0.82],
    ['Applying scene materials', 0.83],
    ['Compiling scene shaders', 0.84],
    ['Joining world comms', 0.84],
    ['Joining scene comms room', 0.84],
    ['Connected to DCL comms', 0.85],
    ['Loading social services', 0.86],
    ['Social ready', 0.87],
    ['Preparing collisions', 0.88],
    ['Cooking collisions', 0.9],
    ['Collisions ready', 0.96],
    ['Spawning player', 0.97],
    ['Loading avatar', 0.975],
    ['Player ready', 0.982],
    ['Settling world', 0.985],
    ['Almost ready', 0.988],
    ['Starting experience', 0.99]
  ]

  for (const [prefix, value] of checkpoints) {
    if (lower.includes(prefix.toLowerCase())) {
      return Math.max(previous, value)
    }
  }

  return previous
}
