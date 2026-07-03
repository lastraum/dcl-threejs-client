/**
 * Patch bundled @dcl/ecs engine.update so @dcl/react-ecs runs after all scene systems.
 * Matches Explorer ordering for closure-driven dynamic UI (splash, loading, menus).
 */
export function patchEngineSystemLoopPartition(code: string): string {
  if (!code.includes('.getSystems()')) return code

  const loopRe =
    /for\(let (\w+) of (\w+)\.getSystems\(\)\)\{let (\w+)=\1\.fn\((\w+)\);(\(0,\w+\.\w+\)|\w+)\(\3,(`A system \(\$\{\1\.name\|\|"anonymous"\}\) returned a thenable\. Systems cannot be async functions\. Documentation: https:\/\/dcl\.gg\/sdk\/sync-systems`)\)\}/g

  if (!loopRe.test(code)) return code
  loopRe.lastIndex = 0

  const hook = 'globalThis.__THREEJS_ENGINE_SYSTEM_LOOP__'
  return code.replace(loopRe, (_match, sysVar, engVar, retVar, dtVar, checkFn, errTpl) => {
    // Minified update() is `for(...){...}let next` — `})let` on one line is a syntax error (ASI).
    const msg = errTpl.replace(new RegExp(`\\$\\{${sysVar}\\.name`, 'g'), '${__sys.name')
    return `${hook}&&${hook}(${engVar}.getSystems(),${dtVar},(__sys,__dt)=>{let ${retVar}=__sys.fn(__dt);${checkFn}(${retVar},${msg})});`
  })
}