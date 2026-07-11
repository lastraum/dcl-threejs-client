/**
 * @dcl/sdk `defineInputModifierComponent` spreads core `InputModifier(engine)` and copies
 * `createOrReplace` by reference at define time. Patching core after seal does not reach scene writes.
 * Inject a hook at define time so locomotion guard wraps the SDK export the scene actually calls.
 */
export const PATCH_INPUT_MODIFIER_SDK_KEY = '__THREEJS_PATCH_INPUT_MODIFIER_SDK__'

const ECS_EXTENDED_RE =
  /function defineInputModifierComponent\((\w+)\)\s*\{\s*const theComponent\s*=\s*InputModifier\(\1\);\s*return\s*\{\s*\.\.\.theComponent,\s*Mode:\s*InputModifierHelper\s*\}\s*;\s*\}/

const SDK_CJS_RE =
  /function defineInputModifierComponent2\((\w+)\)\s*\{\s*const theComponent\s*=\s*\(0,\s*index_gen_1\.InputModifier\)\(\1\);\s*return\s*\{\s*\.\.\.theComponent,\s*Mode:\s*InputModifierHelper2\s*\}\s*;\s*\}/

/** Scene bundle caches `InputModifier3 = InputModifier2(engine)` at @dcl/ecs init — hook must run there too. */
const INPUT_MODIFIER3_ASSIGN_RE =
  /InputModifier3\s*=\s*\/\*\s*@__PURE__\s*\*\/\s*InputModifier2\(engine\);/

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

/** Patch bundled scene code before eval — both @dcl/ecs extended and @dcl/sdk re-exports. */
export function patchInputModifierSdkSpread(code: string): { code: string; applied: boolean } {
  let applied = false
  let out = code
  if (ECS_EXTENDED_RE.test(out)) {
    ECS_EXTENDED_RE.lastIndex = 0
    out = out.replace(ECS_EXTENDED_RE, () => {
      applied = true
      return wrapDefineBody('engine2', 'InputModifierHelper')
    })
  }
  if (SDK_CJS_RE.test(out)) {
    SDK_CJS_RE.lastIndex = 0
    out = out.replace(SDK_CJS_RE, () => {
      applied = true
      return wrapSdkDefineBody('engine2')
    })
  }
  if (INPUT_MODIFIER3_ASSIGN_RE.test(out)) {
    INPUT_MODIFIER3_ASSIGN_RE.lastIndex = 0
    out = out.replace(
      INPUT_MODIFIER3_ASSIGN_RE,
      () =>
        `InputModifier3=(function(__e){const __im=InputModifier2(__e);` +
        `try{globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}&&globalThis.${PATCH_INPUT_MODIFIER_SDK_KEY}(__e,__im,InputModifier(__e))}catch(__err){}return __im})(engine);`
    )
    applied = true
  }
  return { code: out, applied }
}