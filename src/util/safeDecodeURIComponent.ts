/**
 * `decodeURIComponent` throws `URIError: URI malformed` on lone `%` (e.g. scene
 * assets named `puffs_50%.glb`). Scene manifests often use literal percent signs.
 */
export function safeDecodeURIComponent(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}
