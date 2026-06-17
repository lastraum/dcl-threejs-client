/**
 * Off-thread GLB parse is opt-in (`VITE_GLB_OFF_THREAD_PARSE=true`).
 * THREE.js graphs are not structured-cloneable; buffer-transfer rebuild (option B) is future work.
 */
export function isGlbOffThreadParseEnabled(): boolean {
  return import.meta.env.VITE_GLB_OFF_THREAD_PARSE === 'true'
}
