/**
 * Patch bundled @dcl/ecs engine.update so @dcl/react-ecs runs after all scene systems.
 * Matches Explorer ordering for closure-driven dynamic UI (splash, loading, menus).
 */
export function patchEngineSystemLoopPartition(code: string): string {
  if (!code.includes('.getSystems()')) return code

  const hook = 'globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__'
  if (code.includes(hook)) return code

  const thenableMsg =
    'A system (${__sys.name||"anonymous"}) returned a thenable. Systems cannot be async functions. Documentation: https://dcl.gg/sdk/sync-systems'

  const wrapLoop = (
    engVar: string,
    dtVar: string,
    retVar: string,
    checkFn: string
  ): string =>
    `${hook}&&${hook}(${engVar}.getSystems(),${dtVar},(__sys,__dt)=>{let ${retVar}=__sys.fn(__dt);${checkFn}(${retVar},\`${thenableMsg}\`)});`

  const replaceLoop = (
    source: string,
    re: RegExp,
    replaceFn: (
      engVar: string,
      dtVar: string,
      retVar: string,
      checkFn: string
    ) => string
  ): string => {
    re.lastIndex = 0
    return source.replace(
      re,
      (_match, _sysVar: string, engVar: string, retVar: string, dtVar: string, checkFn: string) =>
        replaceFn(engVar, dtVar, retVar, checkFn)
    )
  }

  // Minified single-line loop (legacy planet bundles).
  const minifiedRe =
    /for\(let (\w+) of (\w+)\.getSystems\(\)\)\{let (\w+)=\1\.fn\((\w+)\);(\(0,\w+\.\w+\)|\w+)\(\3,(`A system \(\$\{\1\.name\|\|"anonymous"\}\) returned a thenable\. Systems cannot be async functions\. Documentation: https:\/\/dcl\.gg\/sdk\/sync-systems`)\)\}/g
  if (minifiedRe.test(code)) {
    return replaceLoop(code, minifiedRe, wrapLoop)
  }

  // Formatted loop (camera-operator / SDK7 CJS bundles).
  const formattedRe =
    /for \(const (\w+) of (\w+)\.getSystems\(\)\) \{\s*const (\w+) = \1\.fn\((\w+)\);\s*(\([^)]+\)|\w+)\(\3, `[^`]+`\);\s*\}/g
  if (formattedRe.test(code)) {
    return replaceLoop(code, formattedRe, wrapLoop)
  }

  return code
}