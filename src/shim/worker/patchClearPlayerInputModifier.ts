/**
 * Scene bundles call `clearPlayerInputModifier()` which uses a spread-copied
 * InputModifier3.createOrReplace — post-eval core patches do not reach it.
 * Gate the bundled function at the source.
 */
export const BLOCK_PLAYER_IM_CLEAR_KEY = '__THREEJS_BLOCK_PLAYER_IM_CLEAR__'

const CLEAR_FN_RE = /function clearPlayerInputModifier\(\)\s*\{/

export function patchClearPlayerInputModifierBoundary(code: string): { code: string; applied: boolean } {
  if (!CLEAR_FN_RE.test(code)) return { code, applied: false }
  CLEAR_FN_RE.lastIndex = 0
  const patched = code.replace(
    CLEAR_FN_RE,
    `function clearPlayerInputModifier(){if(globalThis.${BLOCK_PLAYER_IM_CLEAR_KEY}&&globalThis.${BLOCK_PLAYER_IM_CLEAR_KEY}())return;`
  )
  return { code: patched, applied: patched !== code }
}