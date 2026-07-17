/**
 * Patch bundled @dcl/ecs engine.update so @dcl/react-ecs runs after all scene systems.
 * Matches Explorer ordering for closure-driven dynamic UI (splash, loading, menus).
 *
 * IMPORTANT: Never run heavy `/g` regexes across multi-MB minified sources without a
 * unique short needle first — catastrophic backtracking can hang the worker for minutes
 * (Dead Surge ~13MB bin/index.js).
 */
export function patchEngineSystemLoopPartition(code: string): string {
  // Unique stable substring from the stock thenable error message.
  const THENABLE_NEEDLE = 'returned a thenable. Systems cannot be async functions'
  if (!code.includes('.getSystems()') || !code.includes(THENABLE_NEEDLE)) return code

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

  // Minified single-line loop (legacy planet bundles). No /g — single match near getSystems.
  const minifiedRe =
    /for\(let (\w+) of (\w+)\.getSystems\(\)\)\{let (\w+)=\1\.fn\((\w+)\);(\(0,\w+\.\w+\)|\w+)\(\3,(`A system \(\$\{\1\.name\|\|"anonymous"\}\) returned a thenable\. Systems cannot be async functions\. Documentation: https:\/\/dcl\.gg\/sdk\/sync-systems`)\)\}/

  // Formatted loop (camera-operator / SDK7 CJS bundles).
  const formattedRe =
    /for \(const (\w+) of (\w+)\.getSystems\(\)\) \{\s*const (\w+) = \1\.fn\((\w+)\);\s*(\([^)]+\)|\w+)\(\3, `[^`]+`\);\s*\}/

  // Limit search window around the unique needle to avoid scanning the whole 13MB with
  // a complex engine loop regex (pathological backtracking risk on huge minified JS).
  const needleIdx = code.indexOf(THENABLE_NEEDLE)
  if (needleIdx < 0) return code
  const windowStart = Math.max(0, needleIdx - 800)
  const windowEnd = Math.min(code.length, needleIdx + THENABLE_NEEDLE.length + 200)
  const window = code.slice(windowStart, windowEnd)

  let m = minifiedRe.exec(window)
  if (m && m.index != null) {
    const engVar = m[2]!
    const retVar = m[3]!
    const dtVar = m[4]!
    const checkFn = m[5]!
    const absStart = windowStart + m.index
    const absEnd = absStart + m[0].length
    return (
      code.slice(0, absStart) + wrapLoop(engVar, dtVar, retVar, checkFn) + code.slice(absEnd)
    )
  }

  m = formattedRe.exec(window)
  if (m && m.index != null) {
    const engVar = m[2]!
    const retVar = m[3]!
    const dtVar = m[4]!
    const checkFn = m[5]!
    const absStart = windowStart + m.index
    const absEnd = absStart + m[0].length
    return (
      code.slice(0, absStart) + wrapLoop(engVar, dtVar, retVar, checkFn) + code.slice(absEnd)
    )
  }

  // Fallback: full-string single-shot match (no /g) if the loop spans farther than the window.
  minifiedRe.lastIndex = 0
  m = minifiedRe.exec(code)
  if (m && m.index != null) {
    const engVar = m[2]!
    const retVar = m[3]!
    const dtVar = m[4]!
    const checkFn = m[5]!
    return (
      code.slice(0, m.index) +
      wrapLoop(engVar, dtVar, retVar, checkFn) +
      code.slice(m.index + m[0].length)
    )
  }

  formattedRe.lastIndex = 0
  m = formattedRe.exec(code)
  if (m && m.index != null) {
    const engVar = m[2]!
    const retVar = m[3]!
    const dtVar = m[4]!
    const checkFn = m[5]!
    return (
      code.slice(0, m.index) +
      wrapLoop(engVar, dtVar, retVar, checkFn) +
      code.slice(m.index + m[0].length)
    )
  }

  return code
}
