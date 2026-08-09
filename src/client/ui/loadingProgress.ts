/**
 * Map load status strings to a monotonic 0–1 progress fraction (top bar).
 *
 * The asset-loading phase (0.38 → 0.80) is now driven by a numeric fraction
 * computed in `waitForSceneAssets` and passed via `LoadingScreen.setProgress()`.
 * This string parser only provides checkpoint gates for non-asset stages and
 * a lightweight fallback for the asset range.
 */
export function progressFromStatus(message: string, previous: number): number {
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
    ['Compiling scene', 0.35],
    ['compile-progress', 0.35],
    ['Scene script compiled', 0.36],
    ['Scene script running', 0.36],
    ['Loading scene assets', 0.38],
    ['Loading models', 0.38],
    ['Loading scene models', 0.38],
    ['Downloading scene models', 0.38],
    ['Entering world', 0.78],
    ['Finishing scene load', 0.78],
    ['Scene ready', 0.82],
    ['Preparing collisions', 0.83],
    ['Cooking collisions', 0.88],
    ['Collisions ready', 0.96],
    ['Settling world', 0.985],
    ['Spawning player', 0.97],
    ['Joining world comms', 0.86],
    ['Joining scene comms room', 0.86],
    ['Connected to DCL comms', 0.88],
    ['Loading social services', 0.9],
    ['Social ready', 0.92],
    ['Loading avatar', 0.94],
    ['Player ready', 0.96],
    ['Almost ready', 0.98],
    ['Starting experience', 0.99]
  ]

  const lower = message.toLowerCase()
  for (const [prefix, value] of checkpoints) {
    if (lower.includes(prefix.toLowerCase())) {
      return Math.max(previous, value)
    }
  }

  return previous
}
