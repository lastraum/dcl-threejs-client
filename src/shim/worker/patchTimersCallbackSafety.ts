/**
 * Scene utils timers (`@dcl/ecs/timers` / createTimers): one throwing callback aborts the
 * whole system mid-loop, so later delays (e.g. Neurolink 3s drone spawn) never fire.
 *
 * Common: timer callbacks call `stopEmote` which is missing →
 * `(0 , fh.stopEmote) is not a function` kills the rest of the callback + other timers.
 *
 * CRITICAL — keep all rewrites *syntax-valid*:
 * - Minified accruedMs path uses comma expressions: wrap via IIFE (try is a statement).
 * - `(0, m.stopEmote)(` must stay paren-balanced (extra `(` broke PE compile → original
 *   fallback without engine capture → FATAL sceneEngine null after onStart).
 */
export function patchTimersCallbackSafety(code: string): { code: string; patched: number } {
  let patched = 0
  let out = code

  /** Expression-safe wrap — valid after `;` or `,`. */
  const wrapCbExpr = (call: string): string =>
    `(()=>{try{${call}}catch(__timerCbErr){console.warn("[sceneWorker] timer callback threw (continuing)",__timerCbErr)}})()`

  /** Statement-safe wrap — after `;` / block. */
  const wrapCbStmt = (call: string): string =>
    `try{${call}}catch(__timerCbErr){console.warn("[sceneWorker] timer callback threw (continuing)",__timerCbErr)}`

  // Soft-guard stopEmote — RestrictedActions protocol lacks it; PE imports it anyway.
  // MUST preserve call-paren balance: replace `(0, m.stopEmote)(` with ONE open group + call `(`.
  if (out.includes('stopEmote')) {
    out = out.replace(
      /\(0\s*,\s*([A-Za-z_$][\w$]*)\.stopEmote\)\s*\(/g,
      (_full, mod: string) => {
        patched++
        // (0, m.stopEmote)(  →  (typeof m.stopEmote==="function"?m.stopEmote:function(){})(
        return `(typeof ${mod}.stopEmote==="function"?${mod}.stopEmote:function(){})(`
      }
    )
    out = out.replace(
      /([A-Za-z_$][\w$]*)\.stopEmote\s*\(/g,
      (full, mod: string, offset: number) => {
        const prev = out.slice(Math.max(0, offset - 48), offset)
        // Already the true-branch of our guard: `==="function"?mod.stopEmote(`
        if (/===\s*"function"\s*\?\s*$/.test(prev)) return full
        // Already fully guarded form
        if (prev.endsWith('function(){})') || /function\(\)\{\}\)\s*$/.test(prev)) return full
        patched++
        return `(typeof ${mod}.stopEmote==="function"?${mod}.stopEmote:function(){})(`
      }
    )
  }

  const hasTimers =
    out.includes('@dcl/ecs/timers') || out.includes('createTimers') || out.includes('accruedMs')
  if (!hasTimers) {
    return { code: out, patched }
  }

  // New createTimers (armContext / accruedMs): minified uses commas — IIFE only.
  const reArm =
    /(\w+\s*=\s*\{\s*accruedMs\s*:[^}]+\}\s*[;,]\s*)((?:[A-Za-z_$][\w$]*\.)?callback\(\))/g
  out = out.replace(reArm, (full, armAssign: string, call: string) => {
    if (full.includes('__timerCbErr')) return armAssign + call
    patched++
    return armAssign + wrapCbExpr(call)
  })

  // Older createTimers (Neurolink PE): delete then bare callback — statement context.
  //   } else { timers3.delete(timerId); }
  //   timerData.callback();
  if (out.includes('@dcl/ecs/timers') || out.includes('createTimers')) {
    const reOld =
      /(\.delete\([^)]*\)\s*;\s*\}\s*)((?:[A-Za-z_$][\w$]*\.)?callback\(\))\s*;/g
    out = out.replace(reOld, (full, prefix: string, call: string) => {
      if (full.includes('__timerCbErr')) return full
      patched++
      return `${prefix}${wrapCbStmt(call)};`
    })
  }

  // sdk7-utils: for (let callback of callbacks) callback()
  if (out.includes('createTimers') || out.includes('callbacks')) {
    out = out.replace(
      /for\s*\(\s*(?:let|const|var)\s+(callback)\s+of\s+(callbacks)\s*\)\s*callback\(\)/g,
      (_full, cb: string, list: string) => {
        patched++
        return `for(let ${cb} of ${list})${wrapCbStmt(`${cb}()`)}`
      }
    )
  }

  return { code: out, patched }
}
