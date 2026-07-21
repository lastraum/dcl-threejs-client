/**
 * @dcl/sdk `defineInputModifierComponent` spreads core `InputModifier(engine)` and copies
 * `createOrReplace` by reference at define time. Patching core after seal does not reach scene writes.
 * Inject a hook at define time so locomotion guard wraps the SDK export the scene actually calls.
 *
 * Deployed worlds (SpaceRunner) minify to `function R_(e){return{...r7(e),Mode:nL}}` — also patch that.
 */
export const PATCH_INPUT_MODIFIER_SDK_KEY = '__THREEJS_PATCH_INPUT_MODIFIER_SDK__'

const ECS_EXTENDED_RE =
  /function defineInputModifierComponent\((\w+)\)\s*\{\s*const theComponent\s*=\s*InputModifier\(\1\);\s*return\s*\{\s*\.\.\.theComponent,\s*Mode:\s*InputModifierHelper\s*\}\s*;\s*\}/

const SDK_CJS_RE =
  /function defineInputModifierComponent2\((\w+)\)\s*\{\s*const theComponent\s*=\s*\(0,\s*index_gen_1\.InputModifier\)\(\1\);\s*return\s*\{\s*\.\.\.theComponent,\s*Mode:\s*InputModifierHelper2\s*\}\s*;\s*\}/

/** Scene bundle caches `InputModifier3 = InputModifier2(engine)` at @dcl/ecs init — hook must run there too. */
const INPUT_MODIFIER3_ASSIGN_RE =
  /InputModifier3\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*InputModifier2\(engine\);/

/**
 * Minified @dcl/ecs extended helper:
 *   function R_(e){return{...r7(e),Mode:nL}}
 * where nL = { Standard(e){ return { $case:"standard", standard:e } } }
 * SpaceRunner / most production bundles use this form (no defineInputModifierComponent name).
 */
const MINIFIED_MODE_SPREAD_RE =
  /function\s+(\w+)\((\w+)\)\{return\{\.\.\.(\w+)\(\2\),Mode:(\w+)\}\}/g

function wrapDefineBody(engineVar: string, modeHelper: string): string {
  return (
    `function defineInputModifierComponent(${engineVar}){const theComponent=InputModifier(${engineVar});` +
    `const __imOut={...theComponent,Mode:${modeHelper}};` +
    `try{globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}&&globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}(${engineVar},__imOut,theComponent)}catch(__e){}` +
    `return __imOut}`
  )
}

function wrapSdkDefineBody(engineVar: string): string {
  return (
    `function defineInputModifierComponent2(${engineVar}){const theComponent=(0,index_gen_1.InputModifier)(${engineVar});` +
    `const __imOut={...theComponent,Mode:InputModifierHelper2};` +
    `try{globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}&&globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}(${engineVar},__imOut,theComponent)}catch(__e){}` +
    `return __imOut}`
  )
}

function wrapMinifiedModeSpread(
  fnName: string,
  engineVar: string,
  coreFn: string,
  modeHelper: string
): string {
  return (
    `function ${fnName}(${engineVar}){const theComponent=${coreFn}(${engineVar});` +
    `const __imOut={...theComponent,Mode:${modeHelper}};` +
    `try{globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}&&globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}(${engineVar},__imOut,theComponent)}catch(__e){}` +
    `return __imOut}`
  )
}

/** True when nearby source looks like InputModifier Mode.Standard helper (not LightSource.Type etc.). */
function looksLikeInputModifierModeHelper(code: string, modeHelperName: string, fromIndex: number): boolean {
  // Helper is usually declared right after the spread function:
  //   function R_(e){...}var nL,k_=H(()=>{...;nL={Standard(e){return{$case:"standard",standard:e}}}
  const window = code.slice(fromIndex, fromIndex + 400)
  if (window.includes(`${modeHelperName}={Standard`)) return true
  if (window.includes(`${modeHelperName}={Standard(`)) return true
  // Broader: Standard + $case:"standard" within a short range of the helper name
  const std = code.indexOf(`${modeHelperName}=`, fromIndex)
  if (std >= 0 && std - fromIndex < 200) {
    const body = code.slice(std, std + 180)
    if (body.includes('Standard') && body.includes('$case') && body.includes('standard')) return true
  }
  return false
}

/** Patch bundled scene code before eval — both @dcl/ecs extended and @dcl/sdk re-exports. */
export function patchInputModifierSdkSpread(code: string): { code: string; applied: boolean } {
  // Fast reject when nothing InputModifier-like is present.
  if (
    !code.includes('defineInputModifierComponent') &&
    !code.includes('InputModifier3') &&
    !code.includes('Mode:') &&
    !code.includes('disableAll')
  ) {
    return { code, applied: false }
  }
  let applied = false
  let out = code
  // Prefer includes + single replace — avoid .test() advancing lastIndex on /g-less patterns
  // that still thrash on huge sources.
  if (code.includes('defineInputModifierComponent(') && ECS_EXTENDED_RE.test(out)) {
    ECS_EXTENDED_RE.lastIndex = 0
    out = out.replace(ECS_EXTENDED_RE, () => {
      applied = true
      return wrapDefineBody('engine2', 'InputModifierHelper')
    })
  }
  if (code.includes('defineInputModifierComponent2') && SDK_CJS_RE.test(out)) {
    SDK_CJS_RE.lastIndex = 0
    out = out.replace(SDK_CJS_RE, () => {
      applied = true
      return wrapSdkDefineBody('engine2')
    })
  }
  if (code.includes('InputModifier3') && INPUT_MODIFIER3_ASSIGN_RE.test(out)) {
    INPUT_MODIFIER3_ASSIGN_RE.lastIndex = 0
    out = out.replace(
      INPUT_MODIFIER3_ASSIGN_RE,
      () =>
        `InputModifier3=(function(__e){const __im=InputModifier2(__e);` +
        `try{globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}&&globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}(__e,__im,InputModifier(__e))}catch(__err){}return __im})(engine);`
    )
    applied = true
  }

  // Minified Mode-spread (SpaceRunner production bundle).
  if (out.includes(',Mode:') || out.includes('{...')) {
    MINIFIED_MODE_SPREAD_RE.lastIndex = 0
    out = out.replace(MINIFIED_MODE_SPREAD_RE, (full, fnName, engineVar, coreFn, modeHelper, offset) => {
      if (!looksLikeInputModifierModeHelper(out, modeHelper, offset + full.length)) {
        return full
      }
      applied = true
      return wrapMinifiedModeSpread(fnName, engineVar, coreFn, modeHelper)
    })
  }

  return { code: out, applied }
}
